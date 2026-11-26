import { describe, expect, it, vi } from "vitest";
import { firecrawlScrapeProvider } from "./firecrawl-scrape.js";

const KEY = "fake-page-key-456";
const publicHost = async () => [{ address: "203.0.113.10", family: 4 as const }];
const privateHost = async () => [{ address: "10.0.0.5", family: 4 as const }];

function call(
  fetch: typeof globalThis.fetch,
  args: Record<string, unknown> = { url: "https://example.com/page" },
  resolveHostname = publicHost,
) {
  return firecrawlScrapeProvider.run(args, KEY, {
    signal: new AbortController().signal,
    fetch,
    resolveHostname,
    delay: async () => undefined,
  });
}

function page(markdown: string, metadata: Record<string, unknown> = {}) {
  return Response.json({
    success: true,
    data: { markdown, metadata: { title: "Example", statusCode: 200, ...metadata } },
  });
}

describe("firecrawl scrape provider", () => {
  it("posts the documented scrape request with a bearer key, main content by default", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => page("# Hello"));
    const result = await call(fetch);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://example.com/page",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 45000,
    });
    expect(result).toEqual({
      url: "https://example.com/page",
      title: "Example",
      text: "# Hello",
      truncated: false,
    });
  });

  it("can keep the whole page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => page("# Hello"));
    await call(fetch, { url: "https://example.com/", onlyMainContent: false });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).onlyMainContent).toBe(false);
  });

  it("caps the text and says where to continue", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      page("a".repeat(300), { url: "https://example.com/final" }),
    );
    const first = (await call(fetch, { url: "https://example.com/page", maxChars: 100 })) as {
      url: string;
      text: string;
      truncated: boolean;
    };
    expect(first.url).toBe("https://example.com/final");
    expect(first.truncated).toBe(true);
    expect(first.text).toBe(`${"a".repeat(100)}\n\n[Content truncated; continue with offset 100]`);
    const last = (await call(fetch, {
      url: "https://example.com/page",
      maxChars: 100,
      offset: 250,
    })) as { text: string; truncated: boolean };
    expect(last).toMatchObject({ text: "a".repeat(50), truncated: false });
  });

  it("flags a page that answered with an error status", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      page("Not found", { statusCode: 404 }),
    );
    await expect(call(fetch)).resolves.toMatchObject({ pageStatus: 404 });
  });

  it.each([
    ["file:///etc/passwd", publicHost],
    ["http://localhost:3000/admin", publicHost],
    ["http://169.254.169.254/latest/meta-data", publicHost],
    ["https://user:pass@example.com/", publicHost],
    ["https://internal.example.com/", privateHost],
  ])("refuses %s before disclosing it to the provider", async (url, resolve) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(call(fetch, { url }, resolve)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an empty scrape", async () => {
    const empty = vi.fn<typeof globalThis.fetch>(async () => page("   "));
    await expect(call(empty)).rejects.toThrow("no readable content");
    const failed = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: false, error: "blocked" }),
    );
    await expect(call(failed)).rejects.toThrow("no readable content");
  });

  it("names running out of credits and a refused key without echoing the key", async () => {
    const credits = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: false, error: "Payment required" }, { status: 402 }),
    );
    await expect(call(credits)).rejects.toThrow("Firecrawl says the account is out of credits");
    const refused = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: false, error: `Unauthorized: ${KEY}` }, { status: 401 }),
    );
    const error = (await call(refused).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("rejected the saved key");
    expect(error.message).not.toContain(KEY);
  });

  it("does not retry a long rate limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: "Request rate limit exceeded." },
        { status: 429, headers: { "retry-after": "60" } },
      ),
    );
    await expect(call(fetch)).rejects.toThrow("limiting requests");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable provider after one more try", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(call(fetch)).rejects.toThrow("Firecrawl could not be reached.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops reading a body past its size cap", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("x".repeat(10 * 1024 * 1024 + 1)),
    );
    await expect(call(fetch)).rejects.toThrow("Firecrawl returned too much data.");
  });

  it("reports a malformed body", async () => {
    const notJson = vi.fn<typeof globalThis.fetch>(async () => new Response("<html>"));
    await expect(call(notJson)).rejects.toThrow("Firecrawl returned an unexpected response.");
    const wrongShape = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: 4 }));
    await expect(call(wrongShape)).rejects.toThrow("Firecrawl returned an unexpected response.");
  });

  it("gives up at its deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      firecrawlScrapeProvider.run({ url: "https://example.com/" }, KEY, {
        signal: new AbortController().signal,
        fetch,
        resolveHostname: publicHost,
        delay: async () => undefined,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Firecrawl did not answer in time.");
  });

  it("waits out a short Retry-After once, then reads the page", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "slow down" }, { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(page("# Hello"));
    await expect(call(fetch)).resolves.toMatchObject({ text: "# Hello" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
