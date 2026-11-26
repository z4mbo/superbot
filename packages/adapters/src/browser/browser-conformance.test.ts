import type { AdapterContext, BrowserProvider, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComputerBrowserProvider } from "../computers/screens/computer-browser.js";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "computer-1",
};

const seededPages = {
  "https://example.test/form": {
    title: "Signup",
    html: `<!doctype html><html><head><title>Signup</title></head><body>
      <label>Email <input id="email" name="email" /></label>
      <button type="submit">Continue</button>
      <span id="first" hidden>  Share </span><span id="second"> with   team </span><span id="empty"> </span>
      <button aria-labelledby=" second missing first " aria-label="Other"></button>
      <button aria-labelledby=" missing " aria-label="Fallback"></button>
      <button aria-labelledby="   " aria-label="Whitespace fallback"></button>
      <button aria-labelledby="empty" aria-label="Empty fallback"></button>
    </body></html>`,
  },
};

/**
 * Offline conformance: every BrowserProvider must advertise page+refs and honor
 * navigate / snapshot / act. Seed HTML so this stays offline.
 */
async function assertBrowserConformance(provider: BrowserProvider) {
  const desc = provider.describe();
  expect(desc.capabilities.page).toBe(true);
  expect(desc.capabilities.refs).toBe(true);
  expect(desc.contractVersion).toBe("1");

  const navigated = await provider.navigate(
    computer,
    { url: "https://example.test/form" },
    context,
  );
  expect(navigated.fallback).toBeUndefined();
  expect(navigated.title).toBe("Signup");

  const snap = await provider.snapshot(computer, {}, context);
  expect(snap.elements.length).toBeGreaterThan(0);
  expect(snap.tree).toMatch(/\[e\d+\]/);
  const email = snap.elements.find((el) => el.name.toLowerCase().includes("email"));
  const button = snap.elements.find((el) => el.name.toLowerCase().includes("continue"));
  expect(email?.ref).toBeTruthy();
  expect(button?.ref).toBeTruthy();
  expect(snap.elements.map((el) => el.name)).toEqual(
    expect.arrayContaining([
      "with team Share",
      "Fallback",
      "Whitespace fallback",
      "Empty fallback",
    ]),
  );

  const filled = await provider.act(
    computer,
    {
      actions: [
        { kind: "fill", ref: email!.ref, text: "ada@example.test" },
        { kind: "click", ref: button!.ref },
      ],
    },
    context,
  );
  expect(filled.ok).toBe(true);
  expect(filled.completed).toBe(2);
  expect(filled.fallback).toBeUndefined();
}

/**
 * browser_cdp and browser_dialog: a provider either leaves out `cdp` and `dialog` (the tools then
 * say so), or answers them as every other provider does. Neither ever opens a page of its own.
 */
async function assertPageControlConformance(provider: BrowserProvider) {
  if (!provider.cdp && !provider.dialog) return;
  // Both or neither: browser_dialog answers what browser_cdp refuses to.
  expect(Boolean(provider.cdp)).toBe(Boolean(provider.dialog));
  const cold = await provider.cdp!(computer, { method: "Page.getFrameTree" }, context);
  expect(cold).toMatchObject({ ok: false, noPage: true, uncertain: false });
  expect(await provider.dialog!(computer, { action: "status" }, context)).toMatchObject({
    ok: false,
    noPage: true,
  });
  await provider.navigate(computer, { url: "https://example.test/form" }, context);
  const status = await provider.dialog!(computer, { action: "status" }, context);
  expect(status).toMatchObject({ ok: true, url: "https://example.test/form" });
  expect(status.dialog).toBeUndefined();
  expect(
    await provider.dialog!(computer, { action: "accept", only: ["alert"] }, context),
  ).toMatchObject({
    ok: false,
    uncertain: false,
  });
  const read = await provider.cdp!(computer, { method: "Page.getLayoutMetrics" }, context);
  expect(read).toMatchObject({ ok: true, url: "https://example.test/form" });
  expect(read.result).toBeDefined();
}

describe("browser provider conformance", () => {
  it.each([
    ["fake", () => new FakeBrowserProvider({ pages: seededPages })],
    ["emulator", () => new EmulatorBrowserProvider({ pages: seededPages })],
    ["computer (in process)", () => new ComputerBrowserProvider({ pages: seededPages })],
  ] as const)("answers browser_cdp and browser_dialog alike: %s", async (_name, make) => {
    await assertPageControlConformance(make());
  });

  it("holds for fake (offline)", async () => {
    await assertBrowserConformance(new FakeBrowserProvider({ pages: seededPages }));
  });

  it("holds for emulator (offline)", async () => {
    const provider = new EmulatorBrowserProvider({ pages: seededPages });
    expect(provider.describe().id).toBe("emulator");
    await assertBrowserConformance(provider);
  });

  it("returns computer_act fallback when the page tool cannot operate", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    provider.forceFallback = "page browser unavailable";
    const result = await provider.navigate(computer, { url: "https://example.test/form" }, context);
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/unavailable/i);
  });
});
