import { describe, expect, it, vi } from "vitest";
import { ResearchProviderError } from "../../../web/research/research-provider.js";
import { exaSearchProvider } from "./exa-search.js";

const KEY = "fake-search-key-123";
const noWait = vi.fn(async () => undefined);

function call(fetch: typeof globalThis.fetch, args: Record<string, unknown> = { query: "q" }) {
  return exaSearchProvider.run(args, KEY, {
    signal: new AbortController().signal,
    fetch,
    delay: noWait,
  });
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

describe("exa search provider", () => {
  it("posts the documented search request with the key in its header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ results: [] }));
    await call(fetch, {
      query: "  rust async runtimes ",
      maxResults: 50,
      includeDomains: ["https://Docs.rs", " ", 4],
      excludeDomains: ["example.com"],
      publishedAfter: "2026-01-31",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "rust async runtimes",
      numResults: 10,
      type: "auto",
      includeDomains: ["docs.rs"],
      excludeDomains: ["example.com"],
      startPublishedDate: "2026-01-31T00:00:00.000Z",
      contents: { highlights: { maxCharacters: 1000 } },
    });
  });

  it("asks for page text when the call wants it, capped per result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ results: [{ url: "https://a.example/x", title: "A", text: "t".repeat(9_000) }] }),
    );
    const result = (await call(fetch, { query: "q", contents: "text" })) as {
      results: { snippet: string }[];
    };
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).contents).toEqual({
      text: { maxCharacters: 4000 },
    });
    expect(result.results[0]!.snippet).toHaveLength(4000);
  });

  it("maps results, drops unusable URLs and caps the count", async () => {
    const results = [
      {
        url: "https://a.example/one",
        title: " One ",
        publishedDate: "2026-03-01T00:00:00.000Z",
        highlights: ["first", "second"],
      },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "https://user:pass@b.example/", title: "creds" },
      { url: "https://c.example/two", title: null, text: "body text" },
      ...Array.from({ length: 12 }, (_, i) => ({ url: `https://d.example/${i}`, title: "d" })),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ results, costDollars: {} }));
    const found = (await call(fetch, { query: "q", maxResults: 3 })) as { results: unknown[] };
    expect(found.results).toEqual([
      {
        title: "One",
        url: "https://a.example/one",
        publishedDate: "2026-03-01T00:00:00.000Z",
        snippet: "first … second",
      },
      { title: "https://c.example/two", url: "https://c.example/two", snippet: "body text" },
      { title: "d", url: "https://d.example/0", snippet: "" },
    ]);
  });

  it("refuses an empty query without calling the provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(call(fetch, { query: "  " })).rejects.toThrow("query is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a rejected key without retrying or echoing it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: `bad key ${KEY}`, tag: "INVALID_API_KEY" }, { status: 401 }),
    );
    const error = await call(fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResearchProviderError);
    expect((error as Error).message).toContain("rejected the saved key");
    expect((error as Error).message).not.toContain(KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("names running out of credits", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: "no credits", tag: "NO_MORE_CREDITS" }, { status: 402 }),
    );
    await expect(call(fetch)).rejects.toThrow("out of credits");
  });

  it("waits out a short Retry-After once, then succeeds", async () => {
    noWait.mockClear();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ error: "slow down" }, { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(json({ results: [] }));
    await expect(call(fetch)).resolves.toEqual({ results: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  it("reports a long Retry-After instead of waiting inside the turn", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: "slow down" }, { status: 429, headers: { "retry-after": "120" } }),
    );
    await expect(call(fetch)).rejects.toThrow("Try again in 120 seconds");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tries a server error once more, then reports it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("upstream exploded", { status: 503 }),
    );
    await expect(call(fetch)).rejects.toThrow("Exa is unavailable right now.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("quotes a refused request's reason with the key taken out", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: `includeDomains is invalid for ${KEY}`, tag: "INVALID" }, { status: 400 }),
    );
    const error = (await call(fetch).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe("Exa refused the request: includeDomains is invalid for [key].");
  });

  it("reports a malformed body", async () => {
    const notJson = vi.fn<typeof globalThis.fetch>(async () => new Response("<html>"));
    await expect(call(notJson)).rejects.toThrow("Exa returned an unexpected response.");
    const wrongShape = vi.fn<typeof globalThis.fetch>(async () => json({ results: "nope" }));
    await expect(call(wrongShape)).rejects.toThrow("Exa returned an unexpected response.");
  });

  it("gives up at its deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      exaSearchProvider.run({ query: "q" }, KEY, {
        signal: new AbortController().signal,
        fetch,
        delay: noWait,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Exa did not answer in time.");
  });

  it("lets a cancelled run end the call as a cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    await expect(
      exaSearchProvider.run({ query: "q" }, KEY, { signal: controller.signal, fetch: vi.fn() }),
    ).rejects.toThrow("run cancelled");
  });

  it("answers no hits with an empty list", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ results: [] }));
    await expect(call(fetch)).resolves.toEqual({ results: [] });
  });

  it("stops reading a body past its size cap", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    );
    await expect(call(fetch)).rejects.toThrow("Exa returned too much data.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
