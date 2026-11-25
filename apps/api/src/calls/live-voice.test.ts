import type { RealtimeVoice } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { RealtimeVoiceSessionSchema } from "@rakazo/contracts";
import type * as Database from "@rakazo/db";
import * as db from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeVoiceSession, recordRealtimeVoiceTurn } from "./live-voice.js";
import { liveVoiceFor, realtimeVoiceSource } from "./live-voice-status.js";
import type { VoiceDeps } from "./voice.js";
import { effectiveVoiceStatus, toVoiceStatus } from "./voice.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Database>()),
  findDefaultVoiceCredential: vi.fn(),
  findModelCredential: vi.fn(),
  findVoiceCredential: vi.fn(),
  createRepos: vi.fn(),
  appendEventInTransaction: vi.fn(),
  loadMessageAuthor: vi.fn(),
  createThreadMessageInTransaction: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof adapters>()),
  liveVoiceModelProviders: vi.fn(() => []),
  modelConnectionLiveVoiceTurnModes: vi.fn(() => undefined),
  loadModelConnectionLiveVoice: vi.fn(async () => undefined),
  resolveModelConnectionBearer: vi.fn(async () => "fake-model-connection-token"),
}));

const actor = { userId: "test-user", spaceId: "test-space" } as Actor;
const XAI_KEY = "xai-FAKE_SERVER_KEY_0123456789";

type CredentialRow = { provider: string } | null;

function deps(options: { voiceRows?: CredentialRow[]; bot?: Record<string, unknown> | null } = {}) {
  const rows = options.voiceRows ?? [];
  return {
    prisma: {
      userVoiceCredential: {
        findFirst: vi.fn(async ({ where }: { where: { provider: { in: string[] } } }) => {
          return rows.find((row) => row && where.provider.in.includes(row.provider)) ?? null;
        }),
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "sealed" })),
      },
      bot: {
        findFirst: vi.fn(async () =>
          options.bot === undefined
            ? {
                name: "Test Bot",
                instructions: "Answer like a pirate.",
                voiceId: "eve",
                voiceLanguage: "pt-BR",
              }
            : options.bot,
        ),
      },
    },
    secrets: { load: vi.fn(async () => XAI_KEY) },
  } as unknown as VoiceDeps;
}

function defaultVoice(provider: string | null, voiceId = "voice-1") {
  vi.mocked(db.findDefaultVoiceCredential).mockResolvedValue(
    (provider
      ? { id: "cred-1", provider, secretId: "secret-1", voiceId, speechModel: "", isDefault: true }
      : null) as never,
  );
}

function modelConnections(...providers: string[]) {
  vi.mocked(db.findModelCredential).mockImplementation((async (
    _prisma: unknown,
    _scope: unknown,
    provider: string,
  ) => (providers.includes(provider) ? { id: `model-${provider}` } : null)) as never);
}

beforeEach(() => {
  defaultVoice(null);
  modelConnections();
  vi.mocked(db.findVoiceCredential).mockResolvedValue(null);
  vi.stubEnv("AGENT_RUNTIME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("live voice status", () => {
  it("offers neither dictation nor voice chat when nothing is connected", async () => {
    expect(await effectiveVoiceStatus(deps(), actor)).toMatchObject({
      configured: false,
      dictation: false,
      live: null,
    });
  });

  it("offers dictation only when the provider transcribes but has no voice to speak with", async () => {
    defaultVoice("elevenlabs", "");
    expect(await effectiveVoiceStatus(deps(), actor)).toMatchObject({
      dictation: true,
      live: null,
    });
  });

  it("offers no dictation for a provider that only speaks, and no voice chat without listening", async () => {
    defaultVoice("cartesia", "katie");
    expect(await effectiveVoiceStatus(deps(), actor)).toMatchObject({
      ready: true,
      dictation: false,
      live: null,
    });
  });

  it("offers the cascaded voice chat with both turn modes when the provider hears and speaks", async () => {
    defaultVoice("elevenlabs", "rachel");
    expect(await effectiveVoiceStatus(deps(), actor)).toMatchObject({
      dictation: true,
      live: { engine: "cascaded", turnModes: ["push-to-talk", "open-mic"] },
    });
  });

  it("offers a realtime conversation when an xAI key is connected, ahead of the cascaded chat", async () => {
    defaultVoice("xai", "eve");
    const d = deps({ voiceRows: [{ provider: "xai" }] });
    expect(await effectiveVoiceStatus(d, actor)).toMatchObject({
      dictation: true,
      live: { engine: "realtime", turnModes: ["push-to-talk", "open-mic"] },
    });
  });

  it("finds an xAI voice connection that is not the default voice", async () => {
    defaultVoice("elevenlabs", "rachel");
    const d = deps({ voiceRows: [{ provider: "xai" }] });
    expect(await realtimeVoiceSource(d, actor)).toMatchObject({ kind: "voice", provider: "xai" });
  });

  it("offers realtime through the account's xAI model connection with no voice connection", async () => {
    modelConnections("xai");
    expect(await liveVoiceFor(deps(), actor, toVoiceStatus(null))).toEqual({
      engine: "realtime",
      turnModes: ["push-to-talk", "open-mic"],
    });
    expect(await realtimeVoiceSource(deps(), actor)).toMatchObject({
      kind: "voice-model-connection",
      provider: "xai",
    });
  });

  it("does not borrow a model connection the deployment's allowlist refuses", async () => {
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "anthropic");
    modelConnections("xai");
    expect(await liveVoiceFor(deps(), actor, toVoiceStatus(null))).toBeNull();
  });

  it("offers live voice for a subscription sign-in whose provider declares it", async () => {
    vi.mocked(adapters.liveVoiceModelProviders).mockReturnValue(["subscription-provider"]);
    vi.mocked(adapters.modelConnectionLiveVoiceTurnModes).mockReturnValue(["open-mic"]);
    modelConnections("subscription-provider");
    expect(await liveVoiceFor(deps(), actor, toVoiceStatus(null))).toEqual({
      engine: "realtime",
      turnModes: ["open-mic"],
    });
  });

  it("offers nothing for a subscription sign-in whose provider declares no live voice", async () => {
    modelConnections("openai-codex");
    expect(await liveVoiceFor(deps(), actor, toVoiceStatus(null))).toBeNull();
  });
});

describe("createRealtimeVoiceSession", () => {
  function stubXai() {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ value: "client-secret-1", expires_at: 1_900_000_000 }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("mints the session with the stored key and returns only the client secret", async () => {
    defaultVoice("xai", "eve");
    vi.mocked(db.findVoiceCredential).mockResolvedValue({
      id: "cred-1",
      provider: "xai",
      secretId: "secret-1",
      voiceId: "eve",
      speechModel: "",
      isDefault: true,
    } as never);
    const fetch = stubXai();
    const d = deps({ voiceRows: [{ provider: "xai" }] });

    const session = await createRealtimeVoiceSession(d, actor, {
      botId: "bot-1",
      turnMode: "push-to-talk",
    });

    expect(RealtimeVoiceSessionSchema.parse(session)).toEqual(session);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      `Bearer ${XAI_KEY}`,
    );
    expect(JSON.stringify(session)).not.toContain(XAI_KEY);
    expect(session.protocols).toEqual(["xai-client-secret.client-secret-1"]);
    expect(session.turnMode).toBe("push-to-talk");
    const update = session.setup[0] as {
      session: {
        voice: string;
        instructions: string;
        turn_detection: unknown;
        audio: { input: { transcription: { language_hint?: string } } };
      };
    };
    expect(update.session.voice).toBe("eve");
    expect(update.session.turn_detection).toBeNull();
    expect(update.session.instructions).toContain("Answer like a pirate.");
    expect(update.session.instructions).toContain("pt-BR");
    expect(update.session.audio.input.transcription.language_hint).toBe("pt-BR");
  });

  it("refuses a bot outside the caller's Space", async () => {
    defaultVoice("xai", "eve");
    await expect(
      createRealtimeVoiceSession(deps({ bot: null, voiceRows: [{ provider: "xai" }] }), actor, {
        botId: "bot-1",
        turnMode: "open-mic",
      }),
    ).rejects.toBeInstanceOf(db.IsolationError);
  });

  it("refuses when nothing connected can hold a realtime conversation", async () => {
    defaultVoice("elevenlabs", "rachel");
    await expect(
      createRealtimeVoiceSession(deps(), actor, { botId: "bot-1", turnMode: "open-mic" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("uses the subscription's own live voice with the connection's current token", async () => {
    const createSession = vi.fn<RealtimeVoice["createSession"]>(async () => ({
      transport: "websocket" as const,
      url: "wss://realtime.example.test/v1/live",
      protocols: ["client-secret.fake"],
      expiresAt: new Date(1_900_000_000_000),
      audio: { encoding: "pcm16" as const, sampleRate: 24_000 },
      setup: [{ type: "session.update", session: {} }],
      model: "fake-live",
    }));
    vi.mocked(adapters.liveVoiceModelProviders).mockReturnValue(["subscription-provider"]);
    vi.mocked(adapters.modelConnectionLiveVoiceTurnModes).mockReturnValue(["open-mic"]);
    vi.mocked(adapters.loadModelConnectionLiveVoice).mockResolvedValue({
      turnModes: ["open-mic"],
      createSession,
    });
    modelConnections("subscription-provider");

    const session = await createRealtimeVoiceSession(deps(), actor, {
      botId: "bot-1",
      turnMode: "open-mic",
    });

    expect(session.url).toBe("wss://realtime.example.test/v1/live");
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      apiKey: "fake-model-connection-token",
      turnMode: "open-mic",
      language: "pt-BR",
    });
    await expect(
      createRealtimeVoiceSession(deps(), actor, { botId: "bot-1", turnMode: "push-to-talk" }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});

describe("recordRealtimeVoiceTurn", () => {
  it("files a turn under the call without starting a run, once per turn id", async () => {
    vi.mocked(db.createRepos).mockReturnValue({
      getBot: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })),
    } as never);
    const created: unknown[] = [];
    const tx = {
      thread: {
        update: vi.fn(async () => ({ nextMessageSeq: 2, spaceId: "test-space" })),
      },
      message: {
        create: vi.fn(async ({ data }: { data: { clientNonce: string } }) => {
          if (created.some((row) => (row as { clientNonce: string }).clientNonce === data.clientNonce))
            throw Object.assign(new Error("unique"), { code: "P2002" });
          created.push(data);
          return { id: `message-${created.length}`, ...data };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const notify = vi.fn(async () => {});
    vi.mocked(db.appendEventInTransaction).mockResolvedValue({ seq: 7 } as never);
    vi.mocked(db.loadMessageAuthor).mockResolvedValue({ id: "test-user" } as never);
    vi.mocked(db.createThreadMessageInTransaction).mockImplementation(
      (async (client: typeof tx, input: { clientNonce: string }) =>
        client.message.create({ data: input })) as never,
    );
    const input = {
      botId: "bot-1",
      callId: "call-1",
      turnId: "turn-1",
      role: "user" as const,
      text: "What's the weather?",
    };

    await recordRealtimeVoiceTurn({ prisma: prisma as never, events: { notify } }, actor, input);
    await recordRealtimeVoiceTurn({ prisma: prisma as never, events: { notify } }, actor, input);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      role: "user",
      authorUserId: "test-user",
      clientNonce: "call:call-1:turn-1",
      blocks: [{ kind: "text", text: "What's the weather?" }],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.appendEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ callId: "call-1", role: "user" }),
      }),
    );
  });
});
