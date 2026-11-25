import type { VoiceTurnMode } from "@rakazo/contracts";
import { VoiceTurnModeSchema } from "@rakazo/contracts";
import { createStoredPreference } from "./stored-preference";

/** How the viewer takes turns in a voice chat; nothing saved keeps the microphone open. */
export const voiceTurnModePreference = createStoredPreference<VoiceTurnMode>({
  key: "rakazo.voiceTurnMode",
  parse: (raw) => VoiceTurnModeSchema.safeParse(raw).data ?? "open-mic",
  serialize: (mode) => mode,
});

/** The saved mode when the voice supports it, else the first one it does. */
export function preferredTurnMode(supported: readonly VoiceTurnMode[]): VoiceTurnMode {
  const saved = voiceTurnModePreference.get();
  return supported.includes(saved) ? saved : (supported[0] ?? "open-mic");
}
