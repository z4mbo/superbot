import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ cloud: false }));
const accounts = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<string | null> => "jwt-1"),
}));
const active = vi.hoisted(() => ({
  value: { id: "w1", url: "https://bots.example.com" } as { id: string; url: string } | null,
}));

vi.mock("../../cloud/cloud-mode", () => ({
  get CLOUD_WEB() {
    return mode.cloud;
  },
}));
vi.mock("../../cloud/accounts/cloud-accounts", () => ({ loadedCloudAccounts: () => accounts }));
vi.mock("../../cloud/workspaces/active-workspace", () => ({
  startupActiveWorkspace: () => active.value,
}));

const { apiFetch, apiOrigin, apiUrl } = await import("./api-origin.js");

const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));

beforeEach(() => {
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", { location: { origin: "https://page.example" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetch.mockClear();
  accounts.getToken.mockClear();
  mode.cloud = false;
  active.value = { id: "w1", url: "https://bots.example.com" };
});

describe("self-hosted", () => {
  it("keeps paths and the page's own origin", () => {
    expect(apiOrigin()).toBe("https://page.example");
    expect(apiUrl("/api/voice/speak")).toBe("/api/voice/speak");
  });

  it("is plain fetch, with whatever the caller passed", async () => {
    const init: RequestInit = { method: "POST", credentials: "include", headers: { a: "1" } };
    await apiFetch("/api/account/import", init);
    expect(fetch).toHaveBeenCalledWith("/api/account/import", init);
    expect(accounts.getToken).not.toHaveBeenCalled();
  });
});

describe("hosted site", () => {
  beforeEach(() => {
    mode.cloud = true;
  });

  it("resolves paths against the active workspace", () => {
    expect(apiOrigin()).toBe("https://bots.example.com");
    expect(apiUrl("/api/account/export?token=x")).toBe(
      "https://bots.example.com/api/account/export?token=x",
    );
    expect(apiUrl("https://elsewhere.example/a")).toBe("https://elsewhere.example/a");
  });

  it("sends the account token and never a cookie", async () => {
    await apiFetch("/api/voice/speak", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://bots.example.com/api/voice/speak");
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps a request's own headers when no others are given", async () => {
    const request = new Request("https://bots.example.com/rpc/me", {
      method: "POST",
      headers: { "x-rakazo-space-id": "s1" },
    });
    await apiFetch(request);
    const [input, init] = fetch.mock.calls[0]!;
    expect(input).toBe(request);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-rakazo-space-id")).toBe("s1");
    expect(headers.get("authorization")).toBe("Bearer jwt-1");
    expect(init?.credentials).toBe("omit");
  });

  it("sends no token to an address that is not the workspace", async () => {
    await apiFetch("https://elsewhere.example/file", { headers: { a: "1" } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://elsewhere.example/file");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.credentials).toBe("omit");
  });

  it("sends no authorization header while signed out", async () => {
    accounts.getToken.mockResolvedValueOnce(null);
    await apiFetch("/api/health");
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it("refuses to send anything before a workspace is connected", async () => {
    active.value = null;
    expect(apiOrigin()).toBe("https://page.example");
    await expect(apiFetch("/api/health")).rejects.toThrow("No workspace is connected");
    expect(fetch).not.toHaveBeenCalled();
  });
});
