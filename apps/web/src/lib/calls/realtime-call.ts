import { t } from "@lingui/core/macro";
import type { VoiceTurnMode } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import { reportClientError } from "../platform/monitoring";
import { rpc } from "../query/rpc.js";
import { errorText } from "../query/user-error";
import type {
  RealtimeAudio,
  RealtimeSocketFactory,
  RealtimeVoiceHandlers,
} from "./realtime-voice.js";
import {
  browserRealtimeAudio,
  browserRealtimeSocket,
  RealtimeVoiceConnection,
} from "./realtime-voice.js";

type RealtimeIo = { audio: (sampleRate: number) => RealtimeAudio; socket: RealtimeSocketFactory };
const browserIo: RealtimeIo = { audio: browserRealtimeAudio, socket: browserRealtimeSocket };
let io = browserIo;

/** Tests replace the browser's microphone, speaker and socket. */
export function setRealtimeVoiceIo(replacement: RealtimeIo | null): void {
  io = replacement ?? browserIo;
}

/**
 * Opens a realtime call: the server mints a short-lived session, then the page talks to the
 * provider itself. Each finished turn is also filed in the thread under the call, like a voice
 * chat's; `track` holds the call's hang-up until the turn is saved.
 */
export async function openRealtimeCall(options: {
  botId: string;
  turnMode: VoiceTurnMode;
  signal: AbortSignal;
  handlers: RealtimeVoiceHandlers;
  /** The call's id, known once the server opened the session. */
  onSession: (callId: string) => void;
  track: (callId: string, request: Promise<unknown>) => () => void;
}): Promise<RealtimeVoiceConnection> {
  const { botId, handlers } = options;
  const session = await rpc.voice.realtimeSession(
    { botId, turnMode: options.turnMode },
    { signal: options.signal },
  );
  options.signal.throwIfAborted();
  options.onSession(session.callId);
  const connection = new RealtimeVoiceConnection(
    session,
    {
      ...handlers,
      onTurn: (turn) => {
        handlers.onTurn(turn);
        const request = rpc.voice.recordRealtimeTurn({ botId, callId: session.callId, ...turn });
        const release = options.track(session.callId, request);
        void request.catch((error) => reportClientError(error, "voice.turn")).finally(release);
      },
    },
    io.audio(session.audio.sampleRate),
    io.socket,
  );
  try {
    await connection.open();
    options.signal.throwIfAborted();
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/** The call window state a realtime call updates. */
type RealtimeCallView = {
  phase: "ringing" | "listening" | "thinking" | "speaking";
  heard: string;
  caption: string;
  muted: boolean;
  exchanges: CallExchange[];
  connectedAt: number | null;
};

/**
 * Runs a realtime call for the call session: opens it, mirrors the conversation into the call
 * window, and hands the open connection back. `current` turns false once the call ended or moved.
 */
export function startRealtimeCall(host: {
  botId: string;
  turnMode: VoiceTurnMode;
  signal: AbortSignal;
  current: () => boolean;
  view: () => RealtimeCallView | null;
  update: (patch: Partial<RealtimeCallView>) => void;
  callId: () => string;
  setCallId: (callId: string) => void;
  track: (callId: string, request: Promise<unknown>) => () => void;
  hangUp: () => void;
  connected: (connection: RealtimeVoiceConnection) => void;
}): void {
  let sessionCallId = "";
  const live = () => host.current() && host.callId() === sessionCallId;
  void openRealtimeCall({
    botId: host.botId,
    turnMode: host.turnMode,
    signal: host.signal,
    track: host.track,
    onSession: (id) => {
      sessionCallId = id;
      host.setCallId(id);
    },
    handlers: {
      onPhase: (phase) => {
        if (phase !== "connecting" && host.view()?.phase !== "ringing") host.update({ phase });
      },
      onHeard: (heard) => host.update({ heard }),
      onTurn: ({ role, text }) => {
        const view = host.view();
        if (view && live()) host.update({ exchanges: [...view.exchanges, { role, text }] });
      },
      onError: (caption) => host.update({ caption }),
      onClosed: () => {
        if (live()) host.hangUp();
      },
    },
  }).then(
    (connection) => {
      if (host.signal.aborted || !host.current()) {
        connection.close();
        return;
      }
      host.connected(connection);
      connection.setMuted(host.view()?.muted ?? false);
      host.update({ phase: "listening", connectedAt: Date.now() });
    },
    (error: unknown) => {
      if (host.signal.aborted || !host.current()) return;
      reportClientError(error, "voice.realtime");
      host.update({
        phase: "listening",
        caption: errorText(error, t`Could not start the voice chat`),
      });
    },
  );
}
