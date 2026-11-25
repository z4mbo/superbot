import type {
  AdapterContext,
  AdapterDescriptor,
  RealtimeVoice,
  RealtimeVoiceSession,
  RealtimeVoiceSessionRequest,
  VoiceCapabilities,
} from "@rakazo/adapter-kit";
import type { VoiceTurnMode } from "@rakazo/contracts";
import type { VoiceProviderDefinition } from "../../../voice/voice-provider-descriptor.js";
import { ScriptedVoiceProvider, scriptedVoiceEnabled } from "./scripted-voice.js";

export const SCRIPTED_REALTIME_URL = "wss://realtime.scripted.invalid/v1/realtime";
export const SCRIPTED_REALTIME_SECRET = "scripted-client-secret";
const TURN_MODES: readonly VoiceTurnMode[] = ["push-to-talk", "open-mic"];

/** A deterministic realtime session: nothing is minted and nothing is billed. */
export class ScriptedRealtimeVoice implements RealtimeVoice {
  readonly turnModes = TURN_MODES;
  readonly requests: RealtimeVoiceSessionRequest[] = [];

  async createSession(
    request: RealtimeVoiceSessionRequest,
    _context: AdapterContext,
  ): Promise<RealtimeVoiceSession> {
    this.requests.push(request);
    return {
      transport: "websocket",
      url: SCRIPTED_REALTIME_URL,
      protocols: [`scripted.${SCRIPTED_REALTIME_SECRET}`],
      expiresAt: new Date(Date.now() + 300_000),
      audio: { encoding: "pcm16", sampleRate: 24_000 },
      setup: [
        {
          type: "session.update",
          session: {
            voice: request.voiceId ?? null,
            instructions: request.instructions,
            language: request.language ?? null,
            turn_detection: request.turnMode === "open-mic" ? { type: "server_vad" } : null,
          },
        },
      ],
      model: "scripted-realtime",
    };
  }
}

/** The scripted voice with a realtime conversation, for tests of the live voice mode. */
export class ScriptedRealtimeVoiceProvider extends ScriptedVoiceProvider {
  readonly realtime = new ScriptedRealtimeVoice();

  override describe(): AdapterDescriptor<VoiceCapabilities> {
    const described = super.describe();
    return {
      ...described,
      id: "scripted-realtime",
      capabilities: { ...described.capabilities, realtime: true },
    };
  }
}

export const scriptedRealtimeVoice: VoiceProviderDefinition = {
  catalog: {
    name: "Scripted realtime",
    description: "Deterministic realtime fixture for tests. No billed speech.",
    transcribe: true,
  },
  available: scriptedVoiceEnabled,
  realtime: { turnModes: TURN_MODES, connectSources: [] },
  create: () => new ScriptedRealtimeVoiceProvider(),
};
