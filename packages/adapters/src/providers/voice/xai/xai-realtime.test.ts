import type { AdapterContext } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceProviderUnavailableError } from "../../../voice/voice-http.js";
import {
  XAI_REALTIME_ORIGIN,
  XAI_REALTIME_URL,
  XaiRealtimeVoice,
  xaiSessionUpdate,
} from "./xai-realtime.js";
import { xaiVoice } from "./xai-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};
const KEY = "xai-FAKE_SERVER_KEY_0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const request = {
  apiKey: KEY,
  voiceId: "eve",
  instructions: "You are Test Bot.",
  turnMode: "open-mic" as const,
};

describe("XaiRealtimeVoice", () => {
  it("mints a short-lived client secret with the key and hands the browser only that", async () => {
    const fetch = stubFetch(() =>
      Response.json({ value: "xai-realtime-client-secret-fake", expires_at: 1_900_000_000 }),
    );

    const session = await new XaiRealtimeVoice().createSession(request, context);

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({ expires_after: { seconds: 300 } });
    expect(session).toMatchObject({
      transport: "websocket",
      url: XAI_REALTIME_URL,
      protocols: ["xai-client-secret.xai-realtime-client-secret-fake"],
      audio: { encoding: "pcm16", sampleRate: 24_000 },
      model: "grok-voice-latest",
    });
    expect(session.expiresAt.toISOString()).toBe(new Date(1_900_000_000_000).toISOString());
    // The stored key never reaches the browser.
    expect(JSON.stringify(session)).not.toContain(KEY);
  });

  it("lets xAI end turns in open mic, and leaves them to the client in push to talk", () => {
    expect(xaiSessionUpdate(request)).toEqual({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: "You are Test Bot.",
        turn_detection: { type: "server_vad" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "grok-transcribe" },
          },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    });
    const held = xaiSessionUpdate({ ...request, turnMode: "push-to-talk", language: "pt-BR" });
    expect(held.session).toMatchObject({
      turn_detection: null,
      audio: { input: { transcription: { model: "grok-transcribe", language_hint: "pt-BR" } } },
    });
  });

  it("leaves the voice to xAI when none is chosen", () => {
    const update = xaiSessionUpdate({ ...request, voiceId: undefined });
    expect(update.session).not.toHaveProperty("voice");
  });

  it.each([
    [401, { error: "Incorrect API key provided" }, "VOICE_KEY_REJECTED"],
    [400, { error: "Incorrect API key provided: xa***" }, "VOICE_KEY_REJECTED"],
    [403, { error: "Your team has run out of credits" }, "VOICE_OUT_OF_CREDIT"],
  ])("maps a %i refusal to the voice account error", async (status, body, code) => {
    stubFetch(() => Response.json(body, { status }));
    const error = await new XaiRealtimeVoice().createSession(request, context).catch((e) => e);
    expect(error).toBeInstanceOf(VoiceAccountError);
    expect((error as VoiceAccountError).code).toBe(code);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("treats an xAI server error as an outage to wait out", async () => {
    stubFetch(() => Response.json({ error: "internal" }, { status: 503 }));
    await expect(new XaiRealtimeVoice().createSession(request, context)).rejects.toBeInstanceOf(
      VoiceProviderUnavailableError,
    );
  });

  it("refuses an answer without a client secret", async () => {
    stubFetch(() => Response.json({ expires_at: 1_900_000_000 }));
    await expect(new XaiRealtimeVoice().createSession(request, context)).rejects.toThrow(
      /no client secret/,
    );
  });

  it("is declared on the provider, with the origin the browser connects to", () => {
    const provider = xaiVoice.create({});
    expect(provider.describe().capabilities.realtime).toBe(true);
    expect(provider.realtime?.turnModes).toEqual(xaiVoice.realtime?.turnModes);
    expect(xaiVoice.realtime?.connectSources).toEqual([XAI_REALTIME_ORIGIN]);
    expect(new URL(XAI_REALTIME_URL).origin.replace("https:", "wss:")).toBe(XAI_REALTIME_ORIGIN);
  });
});
