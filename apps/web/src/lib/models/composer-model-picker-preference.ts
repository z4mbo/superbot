import { createStoredPreference } from "../preferences/stored-preference";

export const COMPOSER_MODEL_PICKER_STORAGE_KEY = "rakazo.composerModelPicker";

/** The chat's capsule shows its model unless the person turned that off. */
export function normalizeComposerModelPicker(raw: string | null | undefined): boolean {
  return raw?.trim().toLowerCase() !== "off";
}

export const composerModelPickerPreference = createStoredPreference({
  key: COMPOSER_MODEL_PICKER_STORAGE_KEY,
  parse: normalizeComposerModelPicker,
  serialize: (enabled) => (enabled ? "on" : "off"),
});
