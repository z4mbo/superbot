import * as z from "zod";
import { Id } from "../ids.js";

export const VoiceCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  transcribe: z.boolean(),
  keyless: z.boolean().optional(),
  /** The connection takes an optional speech model id that overrides the provider default. */
  speechModel: z.boolean().optional(),
  /**
   * The account's model connection to this provider can authenticate voice, so the key is
   * optional. Set only for an account that has one.
   */
  modelConnection: z.boolean().optional(),
  /** The provider can list its voices for one language, so the picker may offer a filter. */
  languages: z.boolean().optional(),
  /** The provider lists its speech models, so the model field can suggest them. */
  speechModels: z.boolean().optional(),
  /** A voice id can be typed, because a model's voices may be missing from its listing. */
  freeformVoice: z.boolean().optional(),
});
export type VoiceCatalogEntry = z.infer<typeof VoiceCatalogEntrySchema>;

export const VoiceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

export const VoiceModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type VoiceModelInfo = z.infer<typeof VoiceModelInfoSchema>;

export const VoiceCredentialSchema = z.object({
  id: Id,
  provider: z.string(),
  /** False when the connection authenticates with the account's model connection instead. */
  hasKey: z.boolean(),
  isDefault: z.boolean(),
  voiceId: z.string(),
  /** Fish speech-model override. Empty uses the deployment default. */
  speechModel: z.string(),
  transcribe: z.boolean(),
  /** Self-hosted server base URL and model ids (never the key). Empty for hosted providers. */
  endpoint: z.string().default(""),
  /** A separate self-hosted transcription server; empty when `endpoint` transcribes. */
  sttEndpoint: z.string().default(""),
  ttsModel: z.string().default(""),
  sttModel: z.string().default(""),
});
export type VoiceCredential = z.infer<typeof VoiceCredentialSchema>;

/**
 * How a live voice conversation takes turns: holding a talk control (or Space) while speaking, or
 * an open microphone whose pauses end each turn.
 */
export const VOICE_TURN_MODES = ["push-to-talk", "open-mic"] as const;
export const VoiceTurnModeSchema = z.enum(VOICE_TURN_MODES);
export type VoiceTurnMode = z.infer<typeof VoiceTurnModeSchema>;

/**
 * The full voice mode the account can start, chosen by the server. `realtime` is one speech model
 * that hears and answers directly; `cascaded` transcribes each turn, runs the bot and speaks its
 * reply.
 */
export const LiveVoiceSchema = z.object({
  engine: z.enum(["realtime", "cascaded"]),
  turnModes: z.array(VoiceTurnModeSchema).min(1),
});
export type LiveVoice = z.infer<typeof LiveVoiceSchema>;

export const VoiceStatusSchema = z.object({
  configured: z.boolean(),
  ready: z.boolean(),
  transcribe: z.boolean(),
  provider: z.string().nullable(),
  voiceId: z.string(),
  /** A connected provider can turn speech into draft text. Older servers omit it. */
  dictation: z.boolean().default(false),
  /** The voice mode the account can start, or null when nothing connected can hold one. */
  live: LiveVoiceSchema.nullable().default(null),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

/** Longest language tag a bot's voice language or a transcription hint may carry. */
export const VOICE_LANGUAGE_MAX_LENGTH = 35;
/** A BCP-47 language tag such as `en`, `pt-BR` or `zh-Hant`. */
export const VoiceLanguageSchema = z
  .string()
  .trim()
  .max(VOICE_LANGUAGE_MAX_LENGTH)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

/** Groups one conversation's turns in the thread; ":" separates it from a nonce suffix. */
export const VoiceCallIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^:]+$/);

/**
 * What a browser needs to open a realtime voice conversation itself. It carries no long-lived key:
 * the only credential is a short-lived client secret inside `protocols`. `setup` holds the first
 * messages to send once the socket opens (voice, instructions and turn taking). Messages follow
 * the realtime event family (`input_audio_buffer.*`, `response.*`) whatever the provider.
 */
export const RealtimeVoiceSessionSchema = z.object({
  callId: VoiceCallIdSchema,
  transport: z.literal("websocket"),
  url: z.string().url(),
  protocols: z.array(z.string().max(4096)).max(4),
  /** When the client secret stops opening new connections (ISO time). */
  expiresAt: z.string(),
  turnMode: VoiceTurnModeSchema,
  /** Raw little-endian 16-bit mono audio, both ways, at this rate. */
  audio: z.object({ encoding: z.literal("pcm16"), sampleRate: z.number().int().positive() }),
  setup: z.array(z.record(z.string(), z.unknown())).max(8),
});
export type RealtimeVoiceSession = z.infer<typeof RealtimeVoiceSessionSchema>;
