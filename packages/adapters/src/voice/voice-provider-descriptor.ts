import type { VoiceProvider, VoiceUsage } from "@rakazo/adapter-kit";
import type { VoiceCatalogEntry, VoiceTurnMode } from "@rakazo/contracts";

export interface VoiceProviderOptions {
  /** The caller's decision that this connection may reach a private address. */
  allowPrivateEndpoint?: boolean;
}

/** Shared connection fields accepted by deployment speech and provider validation. */
export interface VoiceConnectionFields {
  plaintext: string;
  baseUrl?: string;
  sttBaseUrl?: string;
  sttApiKey?: string;
  ttsModel?: string;
  sttModel?: string;
}

/** One voice provider: everything the factory, the catalog Settings reads, and tests read about it. */
export interface VoiceProviderDefinition {
  /** What Settings shows and what the connection form needs; the id is the registry key. */
  catalog: Omit<VoiceCatalogEntry, "id">;
  /** Whether this server can run it at all; without it the id is unknown here. */
  available?(): boolean;
  /** Whether Settings offers it, beyond being available. */
  listed?(options: VoiceProviderOptions): boolean;
  /** The connection can route synthesis and recognition to operator-specified servers. */
  customEndpoints?: boolean;
  /** Reuse dispatch credential validation before advertising a deployment connection. */
  validateConnection?(connection: VoiceConnectionFields, options: VoiceProviderOptions): void;
  /** A fixed synthesis model when the endpoint has no model selector. */
  synthesisModel?: string;
  /** A fixed recognition model when the deployment supports one model. */
  transcriptionModel?: string;
  /** A unit this model reliably reports and this deployment policy can price. */
  deploymentUsageUnit?(
    operation: "synthesize" | "transcribe",
    model: string,
  ): VoiceUsage["unit"] | undefined;
  /**
   * The provider holds realtime speech-to-speech conversations (its `VoiceProvider.realtime`).
   * Declared here so status can offer it without opening a connection.
   */
  realtime?: {
    turnModes: readonly VoiceTurnMode[];
    /** Origins the browser connects to, which the app's Content-Security-Policy allows. */
    connectSources: readonly string[];
  };
  create(options: VoiceProviderOptions): VoiceProvider;
}
