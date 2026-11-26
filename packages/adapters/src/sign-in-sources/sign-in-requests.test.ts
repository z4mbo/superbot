import type { SignInBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets/secrets.js";
import {
  SIGN_IN_DENIED,
  SIGN_IN_EXPIRED,
  SIGN_IN_FILL_UNAVAILABLE,
  SIGN_IN_FILLED,
  SIGN_IN_NEEDS_RECONNECT,
  SIGN_IN_NOT_CONNECTED,
  SIGN_IN_NOT_HTTPS,
  SIGN_IN_NOT_REVIEWED,
  SIGN_IN_STILL_PENDING,
  SIGN_IN_USE_VAULT_LOGIN,
} from "./sign-in.prompt.js";
import type { SignInRun } from "./sign-in-requests.js";
import { reviewSignInRequest, SignInRequestClosedError, signIn } from "./sign-in-requests.js";
import { SIGN_IN_SOURCE_SECRET_KIND } from "./sign-in-source-connections.js";
import {
  FakeCredentialBroker,
  FakeFillExtension,
  FIXTURE_LOGIN_VALUES,
  signInTables,
  testContext,
} from "./sign-in-sources.test-support.js";

const SITE = "https://login.example.test";
const actor = { userId: "user-1", spaceId: "space-1" };
const LABEL = "Emulator Passwords";

/** A run whose person connected the fake broker, with a card that records each change. */
async function setup(options: { connected?: boolean; opened?: boolean } = {}) {
  const tables = signInTables();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const broker = new FakeCredentialBroker();
  if (options.connected !== false) {
    const sealed = await secretStore.put(
      JSON.stringify({ secret: "emulator-token:emulator-key:fixture" }),
      testContext,
    );
    await tables.secret.create({
      data: { ...sealed, userId: actor.userId, kind: SIGN_IN_SOURCE_SECRET_KIND },
    });
    await tables.signInSource.create({
      data: {
        userId: actor.userId,
        provider: "emulator",
        status: "connected",
        secretId: sealed.id,
        refreshAt: null,
        connectedAt: new Date(),
      },
    });
  }
  const cards: SignInBlock[] = [];
  const fill = new FakeFillExtension();
  const opened = options.opened ?? true;
  const run: SignInRun = {
    deps: { prisma: tables.prisma, secretStore, signInSource: broker },
    actor,
    bot: { id: "bot-1", name: "Helper" },
    runId: "run-1",
    threadId: "thread-1",
    context: testContext,
    vaultLoginFor: async () => undefined,
    postCard: async (block) => {
      cards.push(block);
      return { messageId: `message-${cards.length}` };
    },
    updateCard: async (_messageId, change) => {
      const last = cards.at(-1);
      if (last) cards.push(change(last));
    },
    waitForOpen: vi.fn(async () => opened),
    fill,
    timing: { openWaitMs: 1_000, firstCheckMs: 0, checkEveryMs: () => 0, checkForMs: 0 },
  };
  return { run, tables, broker, cards, fill };
}

const outcome = (cards: SignInBlock[]) => cards.at(-1)?.status;

describe("signing in with a password manager", () => {
  it("asks, waits for the review, and fills the approved login through the browser only", async () => {
    const { run, tables, broker, cards, fill } = await setup();
    const result = await signIn(run, { site: `${SITE}/sign-in?next=%2F` });
    expect(result).toBe(SIGN_IN_FILLED);
    // One request for the site's origin, with the goal the provider shows the person.
    expect(broker.requests).toEqual([{ site: SITE, goal: `Sign in to ${SITE} for the user` }]);
    expect(cards[0]).toEqual({
      kind: "sign_in",
      site: SITE,
      label: LABEL,
      status: "pending",
      requestId: "request-1",
    });
    expect(outcome(cards)).toBe("approved");
    expect(tables.signInRequest.rows[0]).toMatchObject({
      status: "approved",
      messageId: "message-1",
      reference: expect.stringMatching(/^emulator-grant\//),
      grantExpiresAt: expect.any(Date),
    });
    // The browser got the provider's own call for the grant, on the site's origin.
    expect(fill.calls).toHaveLength(1);
    expect(fill.calls[0]?.origin).toBe(SITE);
    // The extension typed the login; the bot's answer, the card and the request row hold none of it.
    for (const value of FIXTURE_LOGIN_VALUES) expect(fill.page).toContain(value);
    const kept = JSON.stringify({ result, cards, rows: tables.signInRequest.rows });
    for (const value of FIXTURE_LOGIN_VALUES) expect(kept).not.toContain(value);
  });

  it("reuses a login approved earlier without asking again, and asks anew once it is gone", async () => {
    const { run, broker, fill } = await setup();
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_FILLED);
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_FILLED);
    expect(broker.requests).toHaveLength(1);
    // The provider says the approval ran out: it is asked for once more, and filled.
    fill.outcome = "no_active_grant";
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_EXPIRED(LABEL));
    expect(broker.requests).toHaveLength(2);
  });

  it("settles the card as declined or expired from the provider's answer, and fills nothing", async () => {
    for (const [state, text] of [
      ["denied", SIGN_IN_DENIED(LABEL)],
      ["expired", SIGN_IN_EXPIRED(LABEL)],
    ] as const) {
      const { run, broker, cards, fill, tables } = await setup();
      broker.answer = () => ({ state });
      expect(await signIn(run, { site: SITE })).toBe(text);
      expect(outcome(cards)).toBe(state);
      expect(tables.signInRequest.rows[0]).toMatchObject({ status: state });
      expect(tables.signInRequest.rows[0]?.reference).toBeUndefined();
      expect(fill.calls).toHaveLength(0);
    }
  });

  it("keeps waiting while the person has not answered, and tells the bot to ask them", async () => {
    const { run, broker, cards, tables } = await setup();
    broker.answer = () => ({ state: "pending" });
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_STILL_PENDING(LABEL));
    expect(outcome(cards)).toBe("pending");
    // Asked again in the same chat, the open request is checked again instead of a new one.
    broker.answer = () => undefined;
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_FILLED);
    expect(broker.requests).toHaveLength(1);
    expect(tables.signInRequest.rows).toHaveLength(1);
  });

  it("closes a request the person never opened, without asking the provider", async () => {
    const { run, broker, cards } = await setup({ opened: false });
    expect(await signIn(run, { site: SITE })).toBe(SIGN_IN_NOT_REVIEWED(LABEL));
    expect(broker.checks).toBe(0);
    expect(outcome(cards)).toBe("expired");
  });

  it("offers to connect when nothing is connected, and to reconnect when the provider drops it", async () => {
    const fresh = await setup({ connected: false });
    expect(await signIn(fresh.run, { site: SITE })).toBe(SIGN_IN_NOT_CONNECTED(LABEL));
    expect(fresh.cards).toEqual([
      { kind: "sign_in", site: SITE, label: LABEL, status: "needs_connection" },
    ]);
    const dropped = await setup();
    dropped.broker.revokedRemotely = true;
    expect(await signIn(dropped.run, { site: SITE })).toBe(SIGN_IN_NEEDS_RECONNECT(LABEL));
    expect(outcome(dropped.cards)).toBe("needs_connection");
    expect(dropped.tables.signInSource.rows[0]?.status).toBe("needs_reconnect");
  });

  it("refuses non-HTTPS sites, prefers a saved login, and asks nothing when the browser can't fill", async () => {
    const { run, broker, cards } = await setup();
    expect(await signIn(run, { site: "http://login.example.test" })).toBe(SIGN_IN_NOT_HTTPS);
    expect(await signIn(run, { site: "https://user:pass@login.example.test" })).toBe(
      SIGN_IN_NOT_HTTPS,
    );
    expect(await signIn({ ...run, vaultLoginFor: async () => "site_login" }, { site: SITE })).toBe(
      SIGN_IN_USE_VAULT_LOGIN("site_login"),
    );
    expect(await signIn({ ...run, fill: undefined }, { site: SITE })).toBe(
      SIGN_IN_FILL_UNAVAILABLE(LABEL),
    );
    expect(broker.requests).toHaveLength(0);
    expect(cards).toHaveLength(0);
  });
});

describe("reviewing a sign-in request", () => {
  it("gives only the person their own pending request's link, exactly as returned, and marks it opened once", async () => {
    const { run, tables, broker } = await setup();
    broker.answer = () => ({ state: "pending" });
    await signIn(run, { site: SITE });
    const [request] = tables.signInRequest.rows;
    const markOpened = vi.fn(async () => undefined);
    const deps = run.deps;
    const review = () => reviewSignInRequest(deps, actor, String(request?.id), markOpened);
    expect(await review()).toEqual({
      approvalLink: broker.approvalLink(String(request?.remoteId)),
    });
    await review();
    expect(markOpened).toHaveBeenCalledTimes(1);
    expect(request?.openedAt).toBeInstanceOf(Date);
    // Another person, another Space, or a settled request: closed.
    await expect(
      reviewSignInRequest(deps, { ...actor, userId: "user-2" }, String(request?.id), markOpened),
    ).rejects.toBeInstanceOf(SignInRequestClosedError);
    await expect(
      reviewSignInRequest(deps, { ...actor, spaceId: "space-2" }, String(request?.id), markOpened),
    ).rejects.toBeInstanceOf(SignInRequestClosedError);
    if (request) request.status = "approved";
    await expect(review()).rejects.toBeInstanceOf(SignInRequestClosedError);
  });
});
