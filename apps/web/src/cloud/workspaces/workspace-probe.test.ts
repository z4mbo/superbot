import { CLOUD_API_VERSION } from "@rakazo/contracts/cloud-web";
import { describe, expect, it, vi } from "vitest";
import { probeWorkspace } from "./workspace-probe.js";

const URL = "https://bots.example.com";
const health = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    ok: true,
    name: "Home",
    version: "1.2.3",
    cloudEnabled: true,
    cloudApi: CLOUD_API_VERSION,
    ...overrides,
  });

type Answer = Response | Error | "hang";

/** Answers each request by path and mode; "hang" never answers until the request is aborted. */
function server(answers: { health?: Answer; opaque?: Answer; session?: Answer }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = url.endsWith("/api/cloud/session")
      ? answers.session
      : init?.mode === "no-cors"
        ? answers.opaque
        : answers.health;
    if (answer === undefined) throw new Error(`unexpected request to ${url}`);
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

function probe(
  fetch: ReturnType<typeof server>,
  getToken: () => Promise<string | null> = async () => "token-1",
) {
  return probeWorkspace(URL, { fetch, getToken, timeoutMs: 50 });
}

describe("probeWorkspace", () => {
  it("is online when the health check matches and the session accepts the token", async () => {
    const fetch = server({
      health: health(),
      session: Response.json({ user: { id: "u", email: "a@example.com", name: "A" } }),
    });
    expect(await probe(fetch)).toEqual({ state: "online", name: "Home", version: "1.2.3" });

    const [healthUrl, healthInit] = fetch.mock.calls[0]!;
    expect(healthUrl).toBe(`${URL}/api/health`);
    expect(healthInit).toMatchObject({ mode: "cors", credentials: "omit", cache: "no-store" });
    const [sessionUrl, sessionInit] = fetch.mock.calls[1]!;
    expect(sessionUrl).toBe(`${URL}/api/cloud/session`);
    expect(sessionInit).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(new Headers(sessionInit?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("is not enabled when the server says cloud access is off", async () => {
    expect(await probe(server({ health: health({ cloudEnabled: false }) }))).toEqual({
      state: "not-enabled",
    });
  });

  it("is incompatible when the server speaks another protocol version", async () => {
    expect(
      await probe(server({ health: health({ cloudApi: CLOUD_API_VERSION + 1, version: "9.0" }) })),
    ).toEqual({ state: "incompatible", version: "9.0" });
  });

  it.each([
    ["a non-JSON body", new Response("<html>hello</html>", { status: 200 })],
    ["a body that is not a health answer", Response.json({ hello: "world" })],
    ["an error status", new Response("nope", { status: 502 })],
    ["a not-found page", Response.json({ ok: true }, { status: 404 })],
  ])("is not enabled for %s", async (_label, answer) => {
    expect(await probe(server({ health: answer }))).toEqual({ state: "not-enabled" });
  });

  it.each([
    ["token_invalid", "token_invalid"],
    ["account_not_allowed", "account_not_allowed"],
    ["email_unverified", "email_unverified"],
    ["no_local_account", "no_local_account"],
    ["something_new", "unknown"],
  ])("is unauthorized with the refusal %s", async (code, reason) => {
    const fetch = server({
      health: health(),
      session: Response.json({ code }, { status: 401 }),
    });
    expect(await probe(fetch)).toEqual({ state: "unauthorized", reason });
  });

  it("is unauthorized with an unknown reason for a refusal without a body", async () => {
    const fetch = server({ health: health(), session: new Response("", { status: 401 }) });
    expect(await probe(fetch)).toEqual({ state: "unauthorized", reason: "unknown" });
  });

  it("does not ask for a session without a token", async () => {
    const fetch = server({ health: health() });
    expect(await probe(fetch, async () => null)).toEqual({
      state: "unauthorized",
      reason: "unknown",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a failed token read like no token", async () => {
    const fetch = server({ health: health() });
    const failing = async (): Promise<string | null> => {
      throw new Error("account service offline");
    };
    expect(await probe(fetch, failing)).toEqual({ state: "unauthorized", reason: "unknown" });
  });

  it("is offline when the session request fails after a good health check", async () => {
    const fetch = server({ health: health(), session: new TypeError("Failed to fetch") });
    expect(await probe(fetch)).toEqual({ state: "offline" });
  });

  it("is offline when the session endpoint has a server error", async () => {
    const fetch = server({ health: health(), session: new Response("boom", { status: 500 }) });
    expect(await probe(fetch)).toEqual({ state: "offline" });
  });

  it("is not enabled when CORS fails but an opaque request reaches the server", async () => {
    const fetch = server({
      health: new TypeError("Failed to fetch"),
      opaque: new Response(null, { status: 200 }),
    });
    expect(await probe(fetch)).toEqual({ state: "not-enabled" });
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
    });
    expect(fetch.mock.calls[1]![0]).toBe(`${URL}/api/health`);
  });

  it("is offline when neither request reaches the server", async () => {
    const fetch = server({
      health: new TypeError("Failed to fetch"),
      opaque: new TypeError("Failed to fetch"),
    });
    expect(await probe(fetch)).toEqual({ state: "offline" });
  });

  it("gives up on a server that never answers", async () => {
    expect(await probe(server({ health: "hang", opaque: "hang" }))).toEqual({ state: "offline" });
  });

  it("gives up on a session request that never answers", async () => {
    expect(await probe(server({ health: health(), session: "hang" }))).toEqual({
      state: "offline",
    });
  });

  it("is not enabled when only the opaque request answers in time", async () => {
    const fetch = server({ health: "hang", opaque: new Response(null, { status: 200 }) });
    expect(await probe(fetch)).toEqual({ state: "not-enabled" });
  });
});
