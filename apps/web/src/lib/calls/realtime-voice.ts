import type { RealtimeVoiceSession, VoiceTurnMode } from "@rakazo/contracts";

/** What the conversation is doing, for the call window's status line. */
export type RealtimePhase = "connecting" | "listening" | "thinking" | "speaking";

export interface RealtimeVoiceHandlers {
  onPhase(phase: RealtimePhase): void;
  /** A finished turn. `turnId` is stable for the turn, so filing it twice files it once. */
  onTurn(turn: { role: "user" | "bot"; text: string; turnId: string }): void;
  /** What the listener has heard of the user's turn so far. */
  onHeard(text: string): void;
  onError(message: string): void;
  /** The connection ended without being closed here. */
  onClosed(): void;
}

/** The microphone and speaker a conversation uses; a fake stands in for it in tests. */
export interface RealtimeAudio {
  /** Opens the microphone; frames arrive as 16-bit samples at the session's rate. */
  start(onFrame: (samples: Int16Array) => void): Promise<void>;
  play(samples: Int16Array): void;
  /** Drops what is queued, for a reply the user talked over. */
  stopPlayback(): void;
  /** Called once queued audio has finished playing. */
  onIdle(listener: () => void): void;
  close(): void;
}

export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type RealtimeSocketFactory = (url: string, protocols: string[]) => RealtimeSocket;

const OPEN = 1;

type ServerEvent = { type?: unknown; [key: string]: unknown };

/**
 * One realtime voice conversation over the realtime event family: the browser streams the
 * microphone to the provider and plays what it says back. Open mic leaves turn ends to the
 * provider's voice detection; push to talk sends audio only while the talk control is held, then
 * commits it and asks for the reply.
 */
export class RealtimeVoiceConnection {
  private socket: RealtimeSocket | null = null;
  private turnMode: VoiceTurnMode;
  private holding = false;
  private muted = false;
  private closed = false;
  private responding = false;
  private botText = "";
  private botTurnId: string | null = null;
  /** The user's transcript per conversation item, which arrives cumulatively. */
  private heard = new Map<string, string>();
  private filedUserItems = new Set<string>();
  private phase: RealtimePhase = "connecting";

  constructor(
    private readonly session: RealtimeVoiceSession,
    private readonly handlers: RealtimeVoiceHandlers,
    private readonly audio: RealtimeAudio,
    private readonly openSocket: RealtimeSocketFactory,
  ) {
    this.turnMode = session.turnMode;
    audio.onIdle(() => {
      if (!this.responding && this.phase === "speaking") this.setPhase("listening");
    });
  }

  async open(): Promise<void> {
    const socket = this.openSocket(this.session.url, this.session.protocols);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        for (const message of this.session.setup) socket.send(JSON.stringify(message));
        resolve();
      };
      socket.onerror = () => reject(new Error("realtime voice connection failed"));
      socket.onclose = () => reject(new Error("realtime voice connection closed"));
    });
    socket.onerror = null;
    socket.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.audio.close();
      this.handlers.onClosed();
    };
    socket.onmessage = (event) => this.receive(event.data);
    await this.audio.start((samples) => this.capture(samples));
    this.setPhase("listening");
  }

  /** Switches how turns end without reconnecting. */
  setTurnMode(turnMode: VoiceTurnMode): void {
    if (turnMode === this.turnMode) return;
    this.turnMode = turnMode;
    this.holding = false;
    this.send({
      type: "session.update",
      session: { turn_detection: turnMode === "open-mic" ? { type: "server_vad" } : null },
    });
    // Audio sent under open mic but never ended as a turn must not join the next held turn.
    if (turnMode === "push-to-talk") this.send({ type: "input_audio_buffer.clear" });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Push to talk: the user starts a turn, cutting off a reply still playing. */
  pressTalk(): void {
    if (this.turnMode !== "push-to-talk" || this.holding) return;
    this.interrupt();
    this.send({ type: "input_audio_buffer.clear" });
    this.holding = true;
    this.setPhase("listening");
  }

  /** Push to talk: the held turn ends; the provider answers it. */
  releaseTalk(): void {
    if (this.turnMode !== "push-to-talk" || !this.holding) return;
    this.holding = false;
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.setPhase("thinking");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.audio.close();
    this.socket?.close(1000);
    this.socket = null;
  }

  private capture(samples: Int16Array): void {
    if (this.closed || this.muted) return;
    if (this.turnMode === "push-to-talk" && !this.holding) return;
    this.send({ type: "input_audio_buffer.append", audio: encodePcm(samples) });
  }

  private interrupt(): void {
    this.audio.stopPlayback();
    if (this.responding) this.send({ type: "response.cancel" });
    this.fileBotTurn();
    this.responding = false;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private setPhase(phase: RealtimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.handlers.onPhase(phase);
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let event: ServerEvent;
    try {
      event = JSON.parse(data) as ServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        // Open mic: the user talked over the reply.
        this.interrupt();
        this.setPhase("listening");
        return;
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        this.setPhase("thinking");
        return;
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed":
        this.hear(event);
        return;
      case "response.created":
        this.responding = true;
        this.botText = "";
        this.botTurnId = text(event.response, "id") || newTurnId();
        this.fileHeardTurns();
        return;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta || !this.responding) return;
        this.audio.play(decodePcm(delta));
        this.setPhase("speaking");
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (this.responding && typeof event.delta === "string") this.botText += event.delta;
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string") this.botText = event.transcript;
        this.fileBotTurn();
        return;
      case "response.done":
        this.fileBotTurn();
        this.responding = false;
        if (this.phase !== "speaking") this.setPhase("listening");
        return;
      case "error":
        this.handlers.onError(errorMessage(event));
        return;
      default:
        return;
    }
  }

  private hear(event: ServerEvent): void {
    const itemId = text(event, "item_id") || "current";
    if (this.filedUserItems.has(itemId)) return;
    const previous = this.heard.get(itemId) ?? "";
    const heard =
      event.type === "conversation.item.input_audio_transcription.delta"
        ? previous + (typeof event.delta === "string" ? event.delta : "")
        : text(event, "transcript");
    this.heard.set(itemId, heard);
    this.handlers.onHeard(heard.trim());
    if (event.type === "conversation.item.input_audio_transcription.completed")
      this.fileUserTurn(itemId);
  }

  /** A reply starting means the user's turn is over, whether or not its transcript completed. */
  private fileHeardTurns(): void {
    for (const itemId of [...this.heard.keys()]) this.fileUserTurn(itemId);
  }

  private fileUserTurn(itemId: string): void {
    const heard = this.heard.get(itemId)?.trim() ?? "";
    this.heard.delete(itemId);
    if (this.filedUserItems.has(itemId)) return;
    this.filedUserItems.add(itemId);
    this.handlers.onHeard("");
    if (heard) this.handlers.onTurn({ role: "user", text: heard, turnId: turnIdFor(itemId) });
  }

  private fileBotTurn(): void {
    const said = this.botText.trim();
    const turnId = this.botTurnId;
    this.botText = "";
    this.botTurnId = null;
    if (said && turnId)
      this.handlers.onTurn({ role: "bot", text: said, turnId: turnIdFor(turnId) });
  }
}

function text(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function errorMessage(event: ServerEvent): string {
  const error = event.error;
  return text(error, "message") || text(event, "message") || "The voice chat ran into a problem.";
}

function newTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`.replace(".", "");
}

/** Provider ids can hold any character; the thread's turn id takes a safe subset. */
export function turnIdFor(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return safe || newTurnId();
}

export function encodePcm(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function decodePcm(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

/** Float samples at the device's rate, as 16-bit samples at the session's rate. */
export function resampleToPcm16(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  const ratio = fromRate / toRate;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, input.length - 1);
    const sample =
      (input[before] ?? 0) + ((input[after] ?? 0) - (input[before] ?? 0)) * (position - before);
    const clamped = Math.max(-1, Math.min(1, sample));
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

/**
 * The browser's microphone and speaker. One audio context at the device's own rate both captures
 * (resampled down) and plays (buffers tagged with the session's rate, which the browser resamples).
 */
export function browserRealtimeAudio(sampleRate: number): RealtimeAudio {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let processor: ScriptProcessorNode | null = null;
  let playhead = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const idle = new Set<() => void>();
  const ensureContext = () => {
    context ??= new AudioContext();
    return context;
  };
  return {
    async start(onFrame) {
      const audio = ensureContext();
      if (audio.state === "suspended") await audio.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const source = audio.createMediaStreamSource(stream);
      // A script processor needs no module URL, so it runs under the app's script policy.
      processor = audio.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) =>
        onFrame(resampleToPcm16(event.inputBuffer.getChannelData(0), audio.sampleRate, sampleRate));
      const silent = audio.createGain();
      silent.gain.value = 0;
      source.connect(processor);
      processor.connect(silent);
      silent.connect(audio.destination);
    },
    play(samples) {
      if (samples.length === 0) return;
      const audio = ensureContext();
      const buffer = audio.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++)
        channel[index] = (samples[index] ?? 0) / 0x8000;
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(audio.destination);
      playhead = Math.max(playhead, audio.currentTime);
      node.start(playhead);
      playhead += buffer.duration;
      playing.add(node);
      node.onended = () => {
        playing.delete(node);
        if (playing.size === 0) for (const listener of idle) listener();
      };
    },
    stopPlayback() {
      for (const node of playing) {
        node.onended = null;
        node.stop();
      }
      playing.clear();
      playhead = 0;
    },
    onIdle(listener) {
      idle.add(listener);
    },
    close() {
      this.stopPlayback();
      processor?.disconnect();
      processor = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      void context?.close();
      context = null;
    },
  };
}

export function browserRealtimeSocket(url: string, protocols: string[]): RealtimeSocket {
  return new WebSocket(url, protocols) as unknown as RealtimeSocket;
}
