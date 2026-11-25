import type { StoredPreference } from "./stored-preference";
import { createStoredPreference } from "./stored-preference";

const preferences = new Map<string, StoredPreference<boolean>>();

/** Whether the sidebar's usage section shows each connection in detail, per signed-in user. */
export function sidebarUsageExpandedPreference(
  userId: string | null | undefined,
): StoredPreference<boolean> {
  const key = `rakazo:sidebar-usage-expanded:${userId ?? ""}`;
  let preference = preferences.get(key);
  if (!preference) {
    preference = createStoredPreference({
      key,
      parse: (raw) => raw === "1",
      serialize: (expanded) => (expanded ? "1" : null),
    });
    preferences.set(key, preference);
  }
  return preference;
}
