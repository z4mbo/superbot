import type { RealtimeVoice } from "@rakazo/adapter-kit";
import type { VoiceTurnMode } from "@rakazo/contracts";
import {
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import {
  liveVoiceModelProviders,
  modelProviderDefinition,
} from "../models/model-provider-registry.js";
import { isVoiceProviderId } from "./voice-factory.js";
import { knownVoiceProvider, voiceProviders } from "./voice-providers.js";

/** The turn modes a voice provider's realtime conversations support; undefined when it has none. */
export function realtimeVoiceTurnModes(provider: string): readonly VoiceTurnMode[] | undefined {
  return isVoiceProviderId(provider)
    ? knownVoiceProvider(provider)?.realtime?.turnModes
    : undefined;
}

/** Voice providers this server has that hold realtime conversations, in catalog order. */
export function realtimeVoiceProviders(): string[] {
  return Object.keys(voiceProviders).filter((id) => realtimeVoiceTurnModes(id) !== undefined);
}

export { liveVoiceModelProviders };

/** The deployment lets the account's model connection to `provider` be used at all. */
export function modelConnectionAllowed(provider: string): boolean {
  return modelProviderAllowed(modelProviderAllowlist(), provider);
}

/** How the Models settings name a model provider, for messages about its connection. */
export function modelProviderName(provider: string): string {
  return modelProviderDefinition(provider)?.displayName ?? provider;
}

/** The turn modes a model connection's own live voice supports; undefined when it has none. */
export function modelConnectionLiveVoiceTurnModes(
  provider: string,
): readonly VoiceTurnMode[] | undefined {
  return modelProviderDefinition(provider)?.liveVoice?.turnModes;
}

/** The realtime conversations a model connection's sign-in holds, loaded when a call starts. */
export async function loadModelConnectionLiveVoice(
  provider: string,
): Promise<RealtimeVoice | undefined> {
  return modelProviderDefinition(provider)?.liveVoice?.load();
}
