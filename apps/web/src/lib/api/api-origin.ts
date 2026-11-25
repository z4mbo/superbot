import { loadedCloudAccounts } from "../../cloud/accounts/cloud-accounts";
import { CLOUD_WEB } from "../../cloud/cloud-mode";
import { startupActiveWorkspace } from "../../cloud/workspaces/active-workspace";

/**
 * Where API requests go. A self-hosted page calls the server that served it, with its cookie.
 * The hosted page calls the workspace it was loaded for, with the account's token and no cookie.
 */
export function apiOrigin(): string {
  if (CLOUD_WEB) {
    const workspace = startupActiveWorkspace();
    if (workspace) return workspace.url;
  }
  return typeof window === "undefined" ? "http://127.0.0.1:5173" : window.location.origin;
}

/** An API path as a URL a request can use: unchanged on a self-hosted page. */
export function apiUrl(path: string): string {
  return CLOUD_WEB && path.startsWith("/") ? `${apiOrigin()}${path}` : path;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * `fetch` for API requests. Self-hosted it is `fetch` itself. On the hosted page a path resolves
 * against the active workspace, the account token rides along as a bearer, and cookies are never
 * sent; the token goes only to that workspace, never to another address passed in.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!CLOUD_WEB) return fetch(input, init);
  const workspace = startupActiveWorkspace();
  if (!workspace) throw new Error("No workspace is connected");
  const target = typeof input === "string" && input.startsWith("/") ? apiUrl(input) : input;
  // Like `fetch(request, init)`: headers given in `init` replace the request's own.
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  if (URL.parse(requestUrl(target))?.origin === workspace.url) {
    const token = await loadedCloudAccounts()?.getToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(target, { ...init, headers, credentials: "omit" });
}
