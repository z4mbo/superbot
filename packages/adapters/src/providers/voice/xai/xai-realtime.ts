import type {
  AdapterContext,
  RealtimeVoice,
  RealtimeVoiceSession,
  RealtimeVoiceSessionRequest,
} from "@rakazo/adapter-kit";
import type { VoiceTurnMode } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import { readVoiceJson } from "../../../voice/voice-http.js";
import { XAI_API, xaiRequestError } from "./xai-http.js";

/** The speech-to-speech model; the alias follows xAI's current voice model. */
export const XAI_REALTIME_MODEL = "grok-voice-latest";
/** Where browsers hold the conversation. */
export const XAI_REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${XAI_REALTIME_MODEL}`;
/** The origin the app's Content-Security-Policy lets the page connect to. */
export const XAI_REALTIME_ORIGIN = "wss://api.x.ai";

/** A browser cannot set headers on a WebSocket, so the client secret rides as a subprotocol. */
const CLIENT_SECRET_PROTOCOL = "xai-client-secret.";
/** Long enough to connect after the RPC returns; an open conversation outlives it. */
const CLIENT_SECRET_SECONDS = 300;
const SAMPLE_RATE = 24_000;
/** Set so the conversation reports what the user said, which lands in the thread. */
const TRANSCRIPTION_MODEL = "grok-transcribe";
export const XAI_REALTIME_TURN_MODES: readonly VoiceTurnMode[] = ["push-to-talk", "open-mic"];

/**
 * xAI's realtime voice: the server mints a short-lived client secret with the stored key and the
 * browser connects to xAI with it, so the key never reaches the page.
 */
export class XaiRealtimeVoice implements RealtimeVoice {
  readonly turnModes = XAI_REALTIME_TURN_MODES;

  async createSession(
    request: RealtimeVoiceSessionRequest,
    context: AdapterContext,
  ): Promise<RealtimeVoiceSession> {
    const res = await fetch(`${XAI_API}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: CLIENT_SECRET_SECONDS } }),
      signal: deadlineSignal(20_000, request.signal ?? context.signal),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw xaiRequestError(res.status, "starting a voice chat", body);
    const secret = clientSecret(body);
    if (!secret) throw new Error("starting a voice chat failed: xAI returned no client secret");
    return {
      transport: "websocket",
      url: XAI_REALTIME_URL,
      protocols: [`${CLIENT_SECRET_PROTOCOL}${secret.value}`],
      expiresAt: secret.expiresAt,
      audio: { encoding: "pcm16", sampleRate: SAMPLE_RATE },
      setup: [xaiSessionUpdate(request)],
      model: XAI_REALTIME_MODEL,
    };
  }
}

/** The first message of a conversation: who speaks, how, and who decides when a turn ends. */
export function xaiSessionUpdate(
  request: Pick<RealtimeVoiceSessionRequest, "voiceId" | "instructions" | "language" | "turnMode">,
): Record<string, unknown> {
  const format = { type: "audio/pcm", rate: SAMPLE_RATE };
  return {
    type: "session.update",
    session: {
      ...(request.voiceId ? { voice: request.voiceId } : {}),
      instructions: request.instructions,
      // Open mic lets xAI's voice activity detection end each turn; push to talk commits the
      // held audio and asks for the reply itself.
      turn_detection: request.turnMode === "open-mic" ? { type: "server_vad" } : null,
      audio: {
        input: {
          format,
          transcription: {
            model: TRANSCRIPTION_MODEL,
            ...(request.language ? { language_hint: request.language } : {}),
          },
        },
        output: { format },
      },
    },
  };
}

function clientSecret(body: unknown): { value: string; expiresAt: Date } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { value, expires_at: expiresAt } = body as { value?: unknown; expires_at?: unknown };
  if (typeof value !== "string" || !value.trim()) return undefined;
  const fallback = Date.now() + CLIENT_SECRET_SECONDS * 1000;
  return {
    value: value.trim(),
    expiresAt: new Date(
      typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt * 1000 : fallback,
    ),
  };
}
