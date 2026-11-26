import {
  liveVoiceModelProviders,
  modelConnectionAllowed,
  modelConnectionLiveVoiceTurnModes,
  realtimeVoiceProviders,
  realtimeVoiceTurnModes,
  voiceCatalogEntry,
} from "@rakazo/adapters";
import type {
  Actor,
  LiveVoice,
  SettingsScope,
  VoiceStatus,
  VoiceTurnMode,
} from "@rakazo/contracts";
import { VOICE_TURN_MODES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  findDefaultVoiceCredential,
  findModelCredential,
  newestVoiceCredentialOrder,
} from "@rakazo/db";

/**
 * Where a realtime conversation comes from, best first: a voice connection to a realtime
 * provider, the account's model connection such a provider can borrow, then a model connection
 * whose own sign-in holds live voice (a subscription's voice mode).
 */
export type RealtimeSource =
  | { kind: "voice"; provider: string; turnModes: readonly VoiceTurnMode[] }
  | { kind: "voice-model-connection"; provider: string; turnModes: readonly VoiceTurnMode[] }
  | { kind: "subscription"; provider: string; turnModes: readonly VoiceTurnMode[] };

/** What the cascaded voice chat supports: an open microphone, or holding to talk. */
const CASCADED_TURN_MODES: readonly VoiceTurnMode[] = VOICE_TURN_MODES;

/**
 * The realtime conversation the account can hold, read from connection rows only: status must
 * not decrypt a saved connection to advertise a capability.
 */
export async function realtimeVoiceSource(
  deps: { prisma: PrismaClient },
  actor: Pick<Actor, "userId" | "spaceId">,
  scope?: SettingsScope,
): Promise<RealtimeSource | null> {
  const providers = realtimeVoiceProviders();
  if (providers.length > 0) {
    const defaultCredential = await findDefaultVoiceCredential(deps.prisma, actor, scope);
    const connected =
      defaultCredential && providers.includes(defaultCredential.provider)
        ? defaultCredential
        : await deps.prisma.userVoiceCredential.findFirst({
            where: { userId: actor.userId, provider: { in: providers } },
            orderBy: newestVoiceCredentialOrder,
            select: { provider: true },
          });
    const turnModes = connected && realtimeVoiceTurnModes(connected.provider);
    if (connected && turnModes) return { kind: "voice", provider: connected.provider, turnModes };
    for (const provider of providers) {
      if (!voiceCatalogEntry(provider)?.modelConnection || !modelConnectionAllowed(provider))
        continue;
      if (!(await findModelCredential(deps.prisma, actor, provider))) continue;
      const modes = realtimeVoiceTurnModes(provider);
      if (modes) return { kind: "voice-model-connection", provider, turnModes: modes };
    }
  }
  for (const provider of liveVoiceModelProviders()) {
    if (!modelConnectionAllowed(provider)) continue;
    if (!(await findModelCredential(deps.prisma, actor, provider))) continue;
    const modes = modelConnectionLiveVoiceTurnModes(provider);
    if (modes) return { kind: "subscription", provider, turnModes: modes };
  }
  return null;
}

/** Turn modes in the order the toggle shows them. */
function ordered(modes: readonly VoiceTurnMode[]): VoiceTurnMode[] {
  return VOICE_TURN_MODES.filter((mode) => modes.includes(mode));
}

/**
 * The voice mode the account can start: a realtime conversation first, else the cascaded voice
 * chat when the default voice provider can both hear and speak.
 */
export async function liveVoiceFor(
  deps: { prisma: PrismaClient },
  actor: Pick<Actor, "userId" | "spaceId">,
  status: Pick<VoiceStatus, "ready" | "transcribe">,
  scope?: SettingsScope,
): Promise<LiveVoice | null> {
  const realtime = await realtimeVoiceSource(deps, actor, scope);
  if (realtime) return { engine: "realtime", turnModes: ordered(realtime.turnModes) };
  if (status.ready && status.transcribe)
    return { engine: "cascaded", turnModes: ordered(CASCADED_TURN_MODES) };
  return null;
}
