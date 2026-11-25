const SETTINGS_SECTIONS = [
  "general",
  "organization",
  "space",
  "models",
  "memory",
  "voice",
  "confirmations",
  "vault",
  "messaging",
  "wallet",
  "usage",
  "computer",
  "labs",
  "billing",
  "updates",
  "workspaces",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The shell overlay a URL opens; the URL is its only source of truth so links and reloads keep it. */
export type ShellOverlay =
  | { kind: "settings"; section: SettingsSection; spaceId: string | null }
  | { kind: "connections" }
  | { kind: "skills" }
  | { kind: "templates" }
  | { kind: "apps" }
  | { kind: "import" }
  | { kind: "mcp"; serverId?: string }
  | null;

const OVERLAY_KEYS = [
  "settings",
  "space",
  "connections",
  "skills",
  "templates",
  "apps",
  // Links to the Store's Connections and Apps from before they were renamed.
  "integrations",
  "plugins",
  "import",
  "mcp",
  "messaging",
] as const;

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function readShellOverlay(params: URLSearchParams): ShellOverlay {
  const section = params.get("settings");
  if (section !== null) {
    return {
      kind: "settings",
      section: isSettingsSection(section) ? section : "general",
      spaceId: params.get("space") || null,
    };
  }
  if (params.has("connections") || params.has("integrations")) return { kind: "connections" };
  if (params.has("skills")) return { kind: "skills" };
  if (params.has("templates")) return { kind: "templates" };
  if (params.has("apps") || params.has("plugins")) return { kind: "apps" };
  if (params.has("import")) return { kind: "import" };
  if (params.has("mcp")) {
    const serverId = params.get("mcp");
    return serverId ? { kind: "mcp", serverId } : { kind: "mcp" };
  }
  // Links from before Messaging moved into settings.
  if (params.has("messaging")) return { kind: "settings", section: "messaging", spaceId: null };
  return null;
}

/** `params` with only `overlay` open; every other param is kept. */
export function withShellOverlay(params: URLSearchParams, overlay: ShellOverlay): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of OVERLAY_KEYS) next.delete(key);
  if (overlay?.kind === "settings") {
    next.set("settings", overlay.section);
    if (overlay.spaceId) next.set("space", overlay.spaceId);
  } else if (overlay?.kind === "mcp") {
    next.set("mcp", overlay.serverId ?? "");
  } else if (overlay) {
    next.set(overlay.kind, "");
  }
  return next;
}

/** A `?search` string that writes flag params bare (`?connections`, not `?connections=`). */
export function searchString(params: URLSearchParams): string {
  const query = params.toString().replace(/=(?=&|$)/g, "");
  return query ? `?${query}` : "";
}

/** Only the overlay params, for redirects that change the route but should keep the overlay open. */
export function shellOverlaySearch(params: URLSearchParams): string {
  const next = withShellOverlay(new URLSearchParams(), readShellOverlay(params));
  // The plan choice opens above the shell from its own link, so it survives the redirect too.
  if (params.has("plans")) next.set("plans", "");
  return searchString(next);
}

const STORE_KINDS = {
  templates: "agents",
  skills: "skills",
  apps: "apps",
  connections: "connections",
} as const;
type StoreKind = keyof typeof STORE_KINDS;
export type StoreSection = (typeof STORE_KINDS)[StoreKind];

/** The Store section an overlay opens; each section keeps the link it had as its own dialog. */
export function storeSection(overlay: ShellOverlay): StoreSection | null {
  return overlay && Object.hasOwn(STORE_KINDS, overlay.kind)
    ? STORE_KINDS[overlay.kind as StoreKind]
    : null;
}

export function storeOverlay(section: StoreSection): ShellOverlay {
  const kind = (Object.keys(STORE_KINDS) as StoreKind[]).find(
    (key) => STORE_KINDS[key] === section,
  )!;
  return { kind };
}
