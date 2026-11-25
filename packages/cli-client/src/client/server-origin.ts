import { isIP } from "node:net";
import { SuperbotError } from "../errors.js";

/** The local Superbot hosting origin, used when nothing else names a server. */
export const DEFAULT_SERVER = "http://127.0.0.1:5173";

export type ServerOrigin = {
  /** The normalized origin with its trailing slash, such as `https://example.test/`. */
  origin: string;
  loopback: boolean;
};

/**
 * Accepts an HTTPS origin, or HTTP on this computer's loopback address for local deployments.
 * Anything beyond the origin (a path, query, fragment or credentials) is refused.
 */
export function serverOrigin(server: string): ServerOrigin {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw SuperbotError.invalidServer();
  }
  const loopback = isLoopback(url.hostname);
  const scheme = url.protocol;
  if (
    (scheme !== "https:" && !(scheme === "http:" && loopback)) ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== "" ||
    // An empty query or fragment still counts; the parsed URL only keeps them in the href.
    url.href.includes("?") ||
    url.href.includes("#") ||
    url.pathname !== "/"
  ) {
    throw SuperbotError.invalidServer();
  }
  return { origin: url.href, loopback };
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address = hostname.replace(/^\[|\]$/g, "");
  const version = isIP(address);
  if (version === 4) return address.startsWith("127.");
  return version === 6 && address === "::1";
}
