import { describe, expect, it, vi } from "vitest";
import type { ResolveHostname } from "../../network/network-address.js";
import { AppFunctionCallError } from "../functions/app-function-runtime.js";
import { APP_FETCH_LIMITS, AppNetwork } from "./app-network.js";

const PUBLIC: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

function network(
  options: {
    respond?: (url: URL, init: RequestInit) => Response;
    resolve?: ResolveHostname;
    readOnly?: boolean;
  } = {},
) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return options.respond?.(new URL(String(input)), init ?? {}) ?? new Response("ok");
  });
  const app = new AppNetwork(["api.example.com"], {
    fetch: fetch as typeof globalThis.fetch,
    resolveHostname: options.resolve ?? PUBLIC,
    readOnly: options.readOnly,
  });
  return { app, sent };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppFunctionCallError);
  return (error as Error).message;
}

describe("AppNetwork", () => {
  it("calls a declared host over HTTPS and hands back status, headers and text", async () => {
    const { app, sent } = network({
      respond: () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { "content-type": "application/json", "set-cookie": "session=secret" },
        }),
    });
    const answer = await app.fetch("https://api.example.com/v1/foods?q=rice#frag", {
      method: "post",
      headers: { authorization: "Bearer app-key" },
      body: { q: "rice" },
    });
    expect(answer).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.example.com/v1/foods?q=rice");
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.body).toBe('{"q":"rice"}');
  });

  it.each([
    ["a host the manifest does not list", "https://evil.example.com/"],
    ["plain HTTP", "http://api.example.com/"],
    ["another port", "https://api.example.com:8443/"],
    ["credentials in the URL", "https://user:pass@api.example.com/"],
    ["an IP address", "https://203.0.113.10/"],
    ["something that is not a URL", "api.example.com/foods"],
  ])("refuses %s before sending anything", async (_label, url) => {
    const { app, sent } = network();
    await refusal(app.fetch(url, undefined));
    expect(sent).toEqual([]);
  });

  it("refuses a declared host that resolves to a private or metadata address", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "192.168.1.2"]) {
      const { app, sent } = network({
        resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      });
      expect(await refusal(app.fetch("https://api.example.com/", undefined))).toBe(
        "Could not reach api.example.com.",
      );
      expect(sent).toEqual([]);
    }
  });

  it("follows no redirect, even to the same host", async () => {
    const { app } = network({
      respond: () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(await refusal(app.fetch("https://api.example.com/", undefined))).toBe(
      "Could not reach api.example.com.",
    );
  });

  it.each([
    ["a cookie", { cookie: "a=b" }],
    ["a forwarding header", { "x-forwarded-for": "10.0.0.1" }],
    ["a host header", { host: "internal" }],
    ["a header split across lines", { "x-note": "a\r\nx-other: b" }],
  ])("refuses %s the app tries to send", async (_label, headers) => {
    const { app, sent } = network();
    await refusal(app.fetch("https://api.example.com/", { headers }));
    expect(sent).toEqual([]);
  });

  it("lets a read-only action read, never change anything elsewhere", async () => {
    const { app, sent } = network({ readOnly: true });
    await app.fetch("https://api.example.com/", { method: "GET" });
    await refusal(app.fetch("https://api.example.com/", { method: "POST", body: "x" }));
    await refusal(app.fetch("https://api.example.com/", { method: "DELETE" }));
    expect(sent).toHaveLength(1);
  });

  it("caps the answer's size and the calls one run makes", async () => {
    const big = "x".repeat(APP_FETCH_LIMITS.responseBytes + 1);
    const { app } = network({ respond: () => new Response(big) });
    expect(await refusal(app.fetch("https://api.example.com/", undefined))).toMatch(/over/);
    const counted = network();
    for (let call = 0; call < APP_FETCH_LIMITS.calls; call++)
      await counted.app.fetch("https://api.example.com/", undefined);
    await refusal(counted.app.fetch("https://api.example.com/", undefined));
    expect(counted.sent).toHaveLength(APP_FETCH_LIMITS.calls);
  });
});
