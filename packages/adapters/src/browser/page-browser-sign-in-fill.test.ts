import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComputerBrowserProvider } from "../computers/screens/computer-browser.js";
import {
  EMULATOR_FILL_METHOD,
  EMULATOR_LOGIN,
} from "../sign-in-sources/sign-in-source-emulator.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const FAKE: ComputerRef = { id: "c-1", botId: "bot-1", kind: "fake", providerRef: "c-1" };
const LIVE: ComputerRef = { id: "c-2", botId: "bot-1", kind: "e2b", providerRef: "c-2" };
const SITE = "https://login.example.test";
const PAGE = `<form><input aria-label="Email" type="email" /><input aria-label="Password" type="password" />
  <input aria-label="Code" autocomplete="one-time-code" /><button>Sign in</button></form>`;
const call = {
  method: EMULATOR_FILL_METHOD,
  params: { token: "emulator-token:emulator-key:k", reference: "emulator-grant/r" },
};

function browserOn(url: string) {
  const browser = new FakeBrowserProvider();
  browser.sessions.get(pageBrowserSessionKey(FAKE, context)).load(url, PAGE);
  return browser;
}

describe("the in-process browser's sign-in extension", () => {
  it("fills the approved login on the site's own page, and snapshots never show it", async () => {
    const browser = browserOn(`${SITE}/sign-in`);
    expect(await browser.signInFill(FAKE, { origin: SITE, call }, context)).toEqual({
      status: "submitted",
    });
    const snapshot = await browser.snapshot(FAKE, {}, context);
    for (const value of Object.values(EMULATOR_LOGIN))
      expect(JSON.stringify(snapshot)).not.toContain(value);
  });

  it("fills nothing on another site, over HTTP, or for a call it does not know", async () => {
    expect(
      await browserOn("https://evil.example.test/").signInFill(
        FAKE,
        { origin: SITE, call },
        context,
      ),
    ).toEqual({ status: "failed" });
    expect(
      await browserOn("http://login.example.test/").signInFill(
        FAKE,
        { origin: "http://login.example.test", call },
        context,
      ),
    ).toEqual({ status: "failed" });
    const browser = browserOn(`${SITE}/`);
    expect(
      await browser.signInFill(
        FAKE,
        { origin: SITE, call: { method: "other", params: {} } },
        context,
      ),
    ).toEqual({ status: "failed" });
    expect(
      await browser.signInFill(
        FAKE,
        { origin: SITE, call: { ...call, params: { ...call.params, token: "x" } } },
        context,
      ),
    ).toEqual({ status: "disconnected" });
    expect(
      await browser.signInFill(
        FAKE,
        { origin: SITE, call: { ...call, params: { ...call.params, reference: "x" } } },
        context,
      ),
    ).toEqual({ status: "no_active_grant" });
  });

  it("is offered on a computer's browser only where it runs in process", () => {
    const browser = new ComputerBrowserProvider();
    expect(browser.canSignInFill(FAKE)).toBe(true);
    expect(browser.canSignInFill(LIVE)).toBe(false);
  });
});
