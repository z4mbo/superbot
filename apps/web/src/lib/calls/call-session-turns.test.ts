import type * as CoreModule from "@rakazo/core";
import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceTurnModePreference } from "../preferences/voice-turn-mode";
import { rpc } from "../query/rpc.js";
import {
  endCall,
  getSnapshot,
  pressToTalk,
  releaseToTalk,
  setTurnMode,
  startCall,
} from "./call-session";
import { dictation } from "./dictation.js";
import { setRealtimeVoiceIo } from "./realtime-call.js";
import type { RealtimeAudio, RealtimeSocket } from "./realtime-voice";
import { speaker } from "./tts.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("./call-pickup.js", () => ({ pickUp: vi.fn(async () => undefined) }));
vi.mock("./dictation.js", () => ({
  usesServerDictation: vi.fn(() => false),
  dictation: {
    recording: false,
    listen: vi.fn(async () => undefined),
    stop: vi.fn(),
    submitHold: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));
vi.mock("./tts.js", () => ({
  speaker: {
    speak: vi.fn(async () => undefined),
    queue: vi.fn(async () => undefined),
    relabel: vi.fn(),
    stop: vi.fn(),
    unlock: vi.fn(),
    isSpeaking: vi.fn(() => false),
    subscribe: vi.fn(() => () => undefined),
    state: { status: "idle" },
  },
}));
vi.mock("../query/rpc.js", () => ({
  recheckSessionOnUnauthorized: vi.fn(),
  rpc: {
    threads: {
      endCall: vi.fn(async () => ({ ok: true })),
      get: vi.fn(async () => ({ botId: "bot-1", threadId: "t", cursor: 1, messages: [] })),
      head: vi.fn(),
      send: vi.fn(async () => ({ runId: "run-1" })),
      subscribe: vi.fn(),
    },
    voice: {
      realtimeSession: vi.fn(),
      recordRealtimeTurn: vi.fn(async () => ({ ok: true })),
    },
  },
}));

const listen = vi.mocked(dictation.listen);
const both = ["push-to-talk", "open-mic"] as const;

beforeEach(() => {
  endCall();
  vi.clearAllMocks();
  vi.mocked(speaker.isSpeaking).mockReturnValue(false);
  voiceTurnModePreference.set("open-mic");
});
afterEach(() => {
  endCall();
  setRealtimeVoiceIo(null);
});

describe("cascaded voice chat turn modes", () => {
  async function call(turnModes: ("push-to-talk" | "open-mic")[] = [...both]) {
    startCall({
      botId: "bot-1",
      botName: "Ada",
      transcribe: true,
      live: { engine: "cascaded", turnModes },
      language: "pt-BR",
    });
    await flush();
  }

  it("listens with automatic turns on an open mic, in the bot's language", async () => {
    await call();
    expect(getSnapshot()).toMatchObject({ engine: "cascaded", turnMode: "open-mic" });
    expect(listen).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "endpoint", language: "pt-BR" }),
    );
  });

  it("keeps the microphone shut in push to talk until the talk control is held", async () => {
    voiceTurnModePreference.set("push-to-talk");
    await call();
    expect(getSnapshot()?.turnMode).toBe("push-to-talk");
    expect(listen).not.toHaveBeenCalled();

    pressToTalk();
    await flush();
    expect(getSnapshot()?.talking).toBe(true);
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ mode: "hold" }));

    releaseToTalk();
    expect(getSnapshot()?.talking).toBe(false);
    expect(dictation.submitHold).toHaveBeenCalledTimes(1);
  });

  it("cuts off a reply still playing when the user holds to talk", async () => {
    voiceTurnModePreference.set("push-to-talk");
    await call();
    vi.mocked(speaker.isSpeaking).mockReturnValue(true);
    pressToTalk();
    expect(speaker.stop).toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("switches modes during the call and remembers the choice", async () => {
    await call();
    setTurnMode("push-to-talk");
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(voiceTurnModePreference.get()).toBe("push-to-talk");
    listen.mockClear();
    setTurnMode("open-mic");
    await flush();
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ mode: "endpoint" }));
    expect(voiceTurnModePreference.get()).toBe("open-mic");
  });

  it("ignores a mode the voice does not support", async () => {
    await call(["open-mic"]);
    setTurnMode("push-to-talk");
    expect(getSnapshot()?.turnMode).toBe("open-mic");
    pressToTalk();
    expect(getSnapshot()?.talking).toBe(false);
  });
});

describe("realtime voice chat", () => {
  class FakeSocket implements RealtimeSocket {
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {
      this.readyState = 3;
    }
    receive(event: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  const audio: RealtimeAudio = {
    start: vi.fn(async () => undefined),
    play: vi.fn(),
    stopPlayback: vi.fn(),
    onIdle: vi.fn(),
    close: vi.fn(),
  };

  it("opens the server's session, takes held turns and files them under the call", async () => {
    let socket: FakeSocket | undefined;
    setRealtimeVoiceIo({
      audio: () => audio,
      socket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => {
          socket!.readyState = 1;
          socket!.onopen?.();
        });
        return socket;
      },
    });
    vi.mocked(rpc.voice.realtimeSession).mockResolvedValue({
      callId: "call-from-server",
      transport: "websocket",
      url: "wss://realtime.example.test/v1/realtime",
      protocols: ["client-secret.fake"],
      expiresAt: new Date(1_900_000_000_000).toISOString(),
      turnMode: "push-to-talk",
      audio: { encoding: "pcm16", sampleRate: 24_000 },
      setup: [{ type: "session.update", session: {} }],
    });
    voiceTurnModePreference.set("push-to-talk");

    startCall({
      botId: "bot-1",
      botName: "Ada",
      live: { engine: "realtime", turnModes: [...both] },
    });
    expect(getSnapshot()?.phase).toBe("ringing");
    await vi.waitFor(() => expect(getSnapshot()?.phase).toBe("listening"));
    expect(rpc.voice.realtimeSession).toHaveBeenCalledWith(
      { botId: "bot-1", turnMode: "push-to-talk" },
      expect.anything(),
    );
    expect(listen).not.toHaveBeenCalled();

    pressToTalk();
    releaseToTalk();
    expect(socket!.sent.map((message) => message.type)).toEqual([
      "session.update",
      "input_audio_buffer.clear",
      "input_audio_buffer.commit",
      "response.create",
    ]);
    socket!.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "Hello",
    });
    expect(getSnapshot()?.exchanges).toEqual([{ role: "user", text: "Hello" }]);
    expect(rpc.voice.recordRealtimeTurn).toHaveBeenCalledWith({
      botId: "bot-1",
      callId: "call-from-server",
      turnId: "item_1",
      role: "user",
      text: "Hello",
    });

    endCall();
    await vi.waitFor(() =>
      expect(rpc.threads.endCall).toHaveBeenCalledWith(
        expect.objectContaining({ botId: "bot-1", callId: "call-from-server" }),
      ),
    );
    expect(audio.close).toHaveBeenCalled();
  });

  it("says why when the voice chat cannot start", async () => {
    vi.mocked(rpc.voice.realtimeSession).mockRejectedValue(new Error("Connect a voice provider"));
    startCall({
      botId: "bot-1",
      botName: "Ada",
      live: { engine: "realtime", turnModes: [...both] },
    });
    await vi.waitFor(() => expect(getSnapshot()?.caption).toContain("Connect a voice provider"));
  });
});
