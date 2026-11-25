import {
  CLOUD_API_VERSION,
  CLOUD_HEALTH_PATH,
  CLOUD_SESSION_PATH,
  parseCloudHealth,
  parseCloudRefusal,
} from "@rakazo/contracts/cloud-web";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { WorkspaceStatus } from "./workspace-status";

export const WORKSPACE_PROBE_TIMEOUT_MS = 5_000;

export type ProbeDeps = {
  fetch: typeof fetch;
  getToken: () => Promise<string | null>;
  timeoutMs?: number;
  /**
   * This browser has had this server online before. An answer the page cannot read then means the
   * server stopped working (a proxy in front answering for a stopped app), not that it was never
   * set up.
   */
  connectedBefore?: boolean;
};

function discard(response: Response): void {
  void bestEffort("discard a probe answer", response.body?.cancel());
}

/** Null for a body that is not JSON. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await withAbort(response.json() as Promise<unknown>, signal);
  } catch {
    return null;
  }
}

/**
 * What one server looks like from this browser (the table in `docs/cloud-web.md`). Each request
 * has its own deadline, so a server that hangs shows as offline instead of checking forever.
 */
export async function probeWorkspace(url: string, deps: ProbeDeps): Promise<WorkspaceStatus> {
  const timeoutMs = deps.timeoutMs ?? WORKSPACE_PROBE_TIMEOUT_MS;
  const request = (path: string, init: RequestInit) => {
    const signal = deadlineSignal(timeoutMs);
    const response = withAbort(
      deps.fetch(`${url}${path}`, { ...init, credentials: "omit", cache: "no-store", signal }),
      signal,
    );
    return { response, signal };
  };

  const unreadable: WorkspaceStatus = { state: deps.connectedBefore ? "offline" : "not-enabled" };
  const health = request(CLOUD_HEALTH_PATH, { mode: "cors" });
  let healthResponse: Response;
  try {
    healthResponse = await health.response;
  } catch {
    return reachableWithoutCors(request, unreadable);
  }
  if (!healthResponse.ok) {
    discard(healthResponse);
    return unreadable;
  }
  const answer = parseCloudHealth(await readJson(healthResponse, health.signal));
  if (!answer?.cloudEnabled) return { state: "not-enabled" };
  if (answer.cloudApi !== CLOUD_API_VERSION) {
    return { state: "incompatible", version: answer.version };
  }

  const token = await bestEffort("read the account token", deps.getToken());
  if (!token) return { state: "unauthorized", reason: "unknown" };
  const session = request(CLOUD_SESSION_PATH, {
    mode: "cors",
    headers: { authorization: `Bearer ${token}` },
  });
  let sessionResponse: Response;
  try {
    sessionResponse = await session.response;
  } catch {
    // The server answered its health check a moment ago, so this is a dropped connection.
    return { state: "offline" };
  }
  if (sessionResponse.ok) {
    discard(sessionResponse);
    return { state: "online", name: answer.name, version: answer.version };
  }
  if (sessionResponse.status === 401 || sessionResponse.status === 403) {
    const reason = parseCloudRefusal(await readJson(sessionResponse, session.signal));
    return { state: "unauthorized", reason: reason ?? "unknown" };
  }
  // A server error: not usable right now, and the next probe asks again.
  discard(sessionResponse);
  return { state: "offline" };
}

/**
 * A server that does not list this site sends no CORS headers, and the browser then fails the
 * request exactly as if nothing answered. An opaque `no-cors` request to the same address still
 * resolves when something answers, which tells "set up the server" apart from "the server is down".
 * The answer itself stays unreadable, so a proxy's error page for a stopped app looks the same as
 * a server that never listed this site; `unreadable` is what the caller makes of that.
 */
async function reachableWithoutCors(
  request: (path: string, init: RequestInit) => { response: Promise<Response> },
  unreadable: WorkspaceStatus,
): Promise<WorkspaceStatus> {
  try {
    await request(CLOUD_HEALTH_PATH, { mode: "no-cors" }).response;
    return unreadable;
  } catch {
    return { state: "offline" };
  }
}
