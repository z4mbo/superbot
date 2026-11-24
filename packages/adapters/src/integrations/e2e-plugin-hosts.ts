import { brandEnv } from "@rakazo/core";

/**
 * TEST ONLY: the hosts an acceptance stack runs fake marketplace plugin servers on.
 *
 * Marketplace plugin MCP endpoints must be public HTTPS, because an approved plugin reaches every
 * Space that installs it. An isolated test stack runs its fake plugin servers on loopback, so it
 * lists their hosts in `SUPERBOT_E2E_ALLOW_PLUGIN_HOSTS` (comma-separated hostnames or IP
 * literals; `RAKAZO_E2E_ALLOW_PLUGIN_HOSTS` also works). Plugin endpoints on those exact hosts are
 * reviewed and called under the private-endpoint policy; HTTPS is still required, and every other
 * plugin endpoint stays public-only. Unset by default, set by no deployment file, and ignored
 * when NODE_ENV is production.
 */
export function e2ePluginHostsFromEnv(source: NodeJS.ProcessEnv): string[] {
  if (source.NODE_ENV === "production") return [];
  return (brandEnv("E2E_ALLOW_PLUGIN_HOSTS", source) ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether a marketplace plugin endpoint is an HTTPS URL on a host the test allowlist names. */
export function allowsE2ePluginEndpoint(
  endpoint: string,
  hosts: readonly string[] | undefined,
): boolean {
  if (!hosts?.length) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return hosts.includes(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}
