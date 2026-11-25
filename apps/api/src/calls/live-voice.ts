import type { RealtimeVoice } from "@rakazo/adapter-kit";
import {
  createVoiceProvider,
  loadModelConnectionLiveVoice,
  modelProviderName,
  resolveModelConnectionBearer,
  voiceCatalogEntry,
} from "@rakazo/adapters";
import type { Actor, RealtimeVoiceSession, VoiceTurnMode } from "@rakazo/contracts";
import { CALL_CLIENT_NONCE_PREFIX, ClientError, newClientId } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  findDefaultVoiceCredential,
  IsolationError,
  isUniqueViolation,
  loadMessageAuthor,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveThreadTarget } from "../threads/thread-target.js";
import type { RealtimeSource } from "./live-voice-status.js";
import { realtimeVoiceSource } from "./live-voice-status.js";
import { realtimeVoiceInstructions } from "./realtime-voice.prompt.js";
import type { VoiceDeps } from "./voice.js";
import {
  loadVoiceCredential,
  voiceContext,
  voiceProviderFor,
  withVoiceConnection,
} from "./voice.js";

/** The bearer and conversation API for a source; the stored key never leaves this function. */
async function openRealtimeSource(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId" | "spaceId">,
  source: RealtimeSource,
  signal?: AbortSignal,
): Promise<{ realtime: RealtimeVoice; apiKey: string; linked: boolean; voiceId?: string }> {
  const keyDeps = { prisma: deps.prisma, secretStore: deps.secrets };
  const scope = { userId: actor.userId, spaceId: actor.spaceId };
  if (source.kind === "voice") {
    const loaded = await loadVoiceCredential(deps, actor, source.provider, undefined, signal);
    const realtime = (await voiceProviderFor(deps, source.provider)).realtime;
    if (!loaded || !realtime) throw noRealtimeVoice();
    return {
      realtime,
      apiKey: loaded.apiKey,
      linked: loaded.linked,
      voiceId: loaded.cred.voiceId || undefined,
    };
  }
  if (source.kind === "voice-model-connection") {
    const realtime = createVoiceProvider(source.provider).realtime;
    if (!realtime) throw noRealtimeVoice();
    const name = voiceCatalogEntry(source.provider)?.name ?? source.provider;
    const apiKey = await withVoiceConnection(source.provider, true, () =>
      resolveModelConnectionBearer(keyDeps, scope, source.provider, name, signal),
    );
    return { realtime, apiKey, linked: true };
  }
  const realtime = await loadModelConnectionLiveVoice(source.provider);
  if (!realtime) throw noRealtimeVoice();
  const apiKey = await resolveModelConnectionBearer(
    keyDeps,
    scope,
    source.provider,
    modelProviderName(source.provider),
    signal,
  );
  return { realtime, apiKey, linked: true };
}

function noRealtimeVoice() {
  return new ClientError("CONFLICT", "Connect a voice provider in Voice settings.");
}

/**
 * Opens a realtime conversation with a bot: the provider mints a short-lived client secret with
 * the stored key, and only that secret reaches the browser.
 */
export async function createRealtimeVoiceSession(
  deps: VoiceDeps,
  actor: Actor,
  input: { botId: string; turnMode: VoiceTurnMode; signal?: AbortSignal },
): Promise<RealtimeVoiceSession> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, archivedAt: null },
    select: { name: true, instructions: true, voiceId: true, voiceLanguage: true },
  });
  if (!bot) throw new IsolationError();
  const source = await realtimeVoiceSource(deps, actor);
  if (!source) throw noRealtimeVoice();
  if (!source.turnModes.includes(input.turnMode))
    throw new ClientError("BAD_REQUEST", "This voice can't take turns that way.");
  const opened = await openRealtimeSource(deps, actor, source, input.signal);
  // The bot's voice belongs to the default voice provider; another provider keeps its own.
  const defaultProvider = (await findDefaultVoiceCredential(deps.prisma, actor))?.provider;
  const voiceId =
    source.kind === "voice" && defaultProvider === source.provider
      ? bot.voiceId || opened.voiceId
      : opened.voiceId;
  const language = bot.voiceLanguage ?? undefined;
  const session = await withVoiceConnection(source.provider, opened.linked, () =>
    opened.realtime.createSession(
      {
        apiKey: opened.apiKey,
        voiceId,
        instructions: realtimeVoiceInstructions({ ...bot, language }),
        language,
        turnMode: input.turnMode,
        signal: input.signal,
      },
      voiceContext(actor, input.signal),
    ),
  );
  getLogger().info("realtime voice session opened", {
    provider: source.provider,
    source: source.kind,
    model: session.model,
    turnMode: input.turnMode,
  });
  return {
    callId: newClientId(),
    transport: session.transport,
    url: session.url,
    protocols: session.protocols,
    expiresAt: session.expiresAt.toISOString(),
    turnMode: input.turnMode,
    audio: session.audio,
    setup: session.setup,
  };
}

/**
 * Files one finished turn of a realtime conversation in the bot's thread. Its nonce carries the
 * call, so the thread groups it with the call's other turns and the hang-up marker; a turn sent
 * twice is filed once. No run starts: the speech model already answered.
 */
export async function recordRealtimeVoiceTurn(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  actor: Actor,
  input: { botId: string; callId: string; turnId: string; role: "user" | "bot"; text: string },
): Promise<{ ok: true }> {
  const target = await resolveThreadTarget(deps.prisma, actor, { botId: input.botId });
  if (target.kind !== "bot") throw new IsolationError();
  const blocks = [{ kind: "text" as const, text: input.text }];
  const clientNonce = `${CALL_CLIENT_NONCE_PREFIX}${input.callId}:${input.turnId}`;
  const seq = await deps.prisma
    .$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: input.role,
        ...(input.role === "user" ? { authorUserId: actor.userId } : { botId: target.botId }),
        blocks,
        clientNonce,
      });
      const author = input.role === "user" ? await loadMessageAuthor(tx, actor.userId) : undefined;
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        type: "thread.message.created",
        payload: {
          messageId: message.id,
          role: input.role,
          blocks,
          callId: input.callId,
          ...(author ? { author } : {}),
        },
      });
      return event.seq;
    }, THREAD_LOCK_TRANSACTION_OPTIONS)
    .catch((error) => {
      if (!isUniqueViolation(error)) throw error;
      return null;
    });
  if (seq !== null) {
    await deps.events.notify(target.threadId, seq).catch((error) => {
      getLogger().error("realtime voice turn notification", error);
    });
  }
  return { ok: true };
}
