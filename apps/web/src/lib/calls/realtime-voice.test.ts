import type { RealtimeVoiceSession } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeAudio, RealtimeSocket } from "./realtime-voice";
import {
  decodePcm,
  encodePcm,
  RealtimeVoiceConnection,
  resampleToPcm16,
  turnIdFor,
} from "./realtime-voice";

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  types() {
    return this.sent.map((message) => message.type);
  }
}

class FakeAudio implements RealtimeAudio {
  frame: ((samples: Int16Array) => void) | null = null;
  played: Int16Array[] = [];
  stopped = 0;
  closed = false;
  idle = new Set<() => void>();
  async start(onFrame: (samples: Int16Array) => void) {
    this.frame = onFrame;
  }
  play(samples: Int16Array) {
    this.played.push(samples);
  }
  stopPlayback() {
    this.stopped += 1;
  }
  onIdle(listener: () => void) {
    this.idle.add(listener);
  }
  close() {
    this.closed = true;
  }
  finish() {
    for (const listener of this.idle) listener();
  }
}

const session = (turnMode: RealtimeVoiceSession["turnMode"]): RealtimeVoiceSession => ({
  callId: "call-1",
  transport: "websocket",
  url: "wss://realtime.example.test/v1/realtime",
  protocols: ["client-secret.fake"],
  expiresAt: new Date(1_900_000_000_000).toISOString(),
  turnMode,
  audio: { encoding: "pcm16", sampleRate: 24_000 },
  setup: [{ type: "session.update", session: { instructions: "Be brief." } }],
});

async function connect(turnMode: RealtimeVoiceSession["turnMode"]) {
  let socket: FakeSocket | undefined;
  const audio = new FakeAudio();
  const handlers = {
    onPhase: vi.fn(),
    onTurn: vi.fn(),
    onHeard: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
  };
  const connection = new RealtimeVoiceConnection(
    session(turnMode),
    handlers,
    audio,
    (url, protocols) => {
      socket = new FakeSocket(url, protocols);
      return socket;
    },
  );
  const opened = connection.open();
  socket!.open();
  await opened;
  return { connection, socket: socket!, audio, handlers };
}

const frame = Int16Array.from([1, -1, 2, -2]);

describe("RealtimeVoiceConnection", () => {
  it("connects with the session's client secret and sends its setup first", async () => {
    const { socket, handlers } = await connect("open-mic");
    expect(socket.url).toBe("wss://realtime.example.test/v1/realtime");
    expect(socket.protocols).toEqual(["client-secret.fake"]);
    expect(socket.sent[0]).toEqual({
      type: "session.update",
      session: { instructions: "Be brief." },
    });
    expect(handlers.onPhase).toHaveBeenLastCalledWith("listening");
  });

  it("streams the microphone all the time with an open mic", async () => {
    const { socket, audio } = await connect("open-mic");
    audio.frame!(frame);
    expect(socket.sent.at(-1)).toEqual({
      type: "input_audio_buffer.append",
      audio: encodePcm(frame),
    });
  });

  it("sends audio only while the talk control is held, then commits and asks for the reply", async () => {
    const { connection, socket, audio, handlers } = await connect("push-to-talk");
    audio.frame!(frame);
    expect(socket.types()).not.toContain("input_audio_buffer.append");

    connection.pressTalk();
    audio.frame!(frame);
    connection.releaseTalk();
    audio.frame!(frame);

    expect(socket.types().slice(1)).toEqual([
      "input_audio_buffer.clear",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "response.create",
    ]);
    expect(handlers.onPhase).toHaveBeenLastCalledWith("thinking");
  });

  it("plays the reply, and files what both sides said as turns", async () => {
    const { socket, audio, handlers } = await connect("open-mic");
    socket.receive({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "What's the",
    });
    expect(handlers.onHeard).toHaveBeenLastCalledWith("What's the");
    socket.receive({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "What's the time?",
    });
    socket.receive({ type: "response.created", response: { id: "resp_1" } });
    socket.receive({ type: "response.output_audio.delta", delta: encodePcm(frame) });
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "It's " });
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "noon." });
    socket.receive({ type: "response.done" });

    expect(audio.played).toHaveLength(1);
    expect(Array.from(audio.played[0]!)).toEqual(Array.from(frame));
    expect(handlers.onPhase).toHaveBeenLastCalledWith("speaking");
    expect(handlers.onTurn.mock.calls.map(([turn]) => turn)).toEqual([
      { role: "user", text: "What's the time?", turnId: "item_1" },
      { role: "bot", text: "It's noon.", turnId: "resp_1" },
    ]);
    audio.finish();
    expect(handlers.onPhase).toHaveBeenLastCalledWith("listening");
  });

  it("stops the reply when the user talks over it", async () => {
    const { socket, audio, handlers } = await connect("open-mic");
    socket.receive({ type: "response.created", response: { id: "resp_1" } });
    socket.receive({ type: "response.output_audio.delta", delta: encodePcm(frame) });
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "Once upon" });
    socket.receive({ type: "input_audio_buffer.speech_started" });

    expect(audio.stopped).toBe(1);
    expect(socket.types()).toContain("response.cancel");
    expect(handlers.onTurn).toHaveBeenCalledWith({
      role: "bot",
      text: "Once upon",
      turnId: "resp_1",
    });
    expect(handlers.onPhase).toHaveBeenLastCalledWith("listening");
  });

  it("switches turn taking on the open connection", async () => {
    const { connection, socket } = await connect("open-mic");
    connection.setTurnMode("push-to-talk");
    connection.setTurnMode("open-mic");
    expect(socket.sent.slice(1)).toEqual([
      { type: "session.update", session: { turn_detection: null } },
      { type: "input_audio_buffer.clear" },
      { type: "session.update", session: { turn_detection: { type: "server_vad" } } },
    ]);
  });

  it("sends nothing while muted", async () => {
    const { connection, socket, audio } = await connect("open-mic");
    connection.setMuted(true);
    audio.frame!(frame);
    expect(socket.types()).not.toContain("input_audio_buffer.append");
  });

  it("reports provider errors and a connection the provider closed", async () => {
    const { socket, audio, handlers } = await connect("open-mic");
    socket.receive({ type: "error", error: { message: "Session expired" } });
    expect(handlers.onError).toHaveBeenCalledWith("Session expired");
    socket.onclose?.();
    expect(handlers.onClosed).toHaveBeenCalledTimes(1);
    expect(audio.closed).toBe(true);
  });

  it("closes the socket and the microphone when hung up", async () => {
    const { connection, socket, audio, handlers } = await connect("open-mic");
    connection.close();
    socket.onclose?.();
    expect(socket.closed).toBe(true);
    expect(audio.closed).toBe(true);
    expect(handlers.onClosed).not.toHaveBeenCalled();
  });

  it("fails to open when the provider refuses the connection", async () => {
    let socket: FakeSocket | undefined;
    const connection = new RealtimeVoiceConnection(
      session("open-mic"),
      { onPhase() {}, onTurn() {}, onHeard() {}, onError() {}, onClosed() {} },
      new FakeAudio(),
      (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    );
    const opened = connection.open();
    socket!.onerror?.();
    await expect(opened).rejects.toThrow(/failed/);
  });
});

describe("realtime audio encoding", () => {
  it("round-trips 16-bit samples through base64", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect(Array.from(decodePcm(encodePcm(samples)))).toEqual(Array.from(samples));
  });

  it("resamples device audio down to the session rate", () => {
    const input = new Float32Array(480).fill(0.5);
    const output = resampleToPcm16(input, 48_000, 24_000);
    expect(output).toHaveLength(240);
    expect(output[10]).toBe(Math.round(0.5 * 0x7fff - 0.5));
  });

  it("keeps provider ids usable as turn ids", () => {
    expect(turnIdFor("item_1")).toBe("item_1");
    expect(turnIdFor("resp:1/2")).toBe("resp-1-2");
  });
});
