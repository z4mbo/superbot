import type { BrowserProvider, ComputerRef } from "@rakazo/adapter-kit";
import type { SignInBlock } from "@rakazo/contracts";
import * as Db from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmulatorSignInSourceProvider } from "../../sign-in-sources/sign-in-source-emulator.js";
import type { SignInRun } from "../../sign-in-sources/sign-in-requests.js";
import * as Requests from "../../sign-in-sources/sign-in-requests.js";
import * as Messages from "../assembly/run-messages.js";
import * as Notifications from "../lifecycle/run-notifications.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import * as Computer from "./run-tools-computer.js";
import { signInTools } from "./run-tools-sign-in.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  changeSignInBlock: vi.fn(async () => ({ seq: 7 })),
}));
vi.mock("../../sign-in-sources/sign-in-requests.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Requests>()),
  signIn: vi.fn(async () => "signed"),
}));
vi.mock("./run-tools-computer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Computer>()),
  screenBlocked: vi.fn(async () => undefined),
}));
vi.mock("../assembly/run-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Messages>()),
  publishMessage: vi.fn(async () => ({ id: "message-1" })),
}));
vi.mock("../lifecycle/run-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  notifyRun: vi.fn(async () => undefined),
}));

const COMPUTER: ComputerRef = { id: "computer-1", botId: "bot-1", kind: "fake", providerRef: "c" };
const card: SignInBlock = {
  kind: "sign_in",
  site: "https://login.example.test",
  label: "Emulator Passwords",
  status: "pending",
  requestId: "request-1",
};

function fakeCtx(
  options: {
    signInSource?: boolean;
    browser?: Partial<BrowserProvider>;
    blocks?: unknown;
    follow?: () => AsyncIterable<unknown>;
  } = {},
) {
  const getComputer = vi.fn(async () => COMPUTER);
  const ctx = {
    deps: {
      prisma: {
        event: { findFirst: async () => ({ seq: 3 }) },
        message: { findFirst: async () => ({ blocks: options.blocks ?? [card] }) },
      },
      secretStore: {},
      signInSource: options.signInSource === false ? null : new EmulatorSignInSourceProvider(),
      events: {
        notify: vi.fn(async () => undefined),
        follow: vi.fn(options.follow ?? (async function* () {})),
      },
    },
    run: {
      id: "run-1",
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      trigger: "user",
    },
    bot: { id: "bot-1", name: "Helper" },
    providers: { browser: options.browser ?? {} },
    computer: { get: getComputer, heldForTakeover: false },
    context: { signal: new AbortController().signal },
  };
  return { ctx, getComputer };
}

async function callTool(ctx: unknown, site = "https://login.example.test") {
  return signInTools.sign_in!(
    ctx as never,
    { name: "sign_in", args: { site }, executionId: "call-1", finish: async (r: unknown) => r } as never,
  );
}

/** The run the tool handed to the sign-in flow. */
function handedRun(): SignInRun {
  const [run] = vi.mocked(Requests.signIn).mock.calls.at(-1) ?? [];
  if (!run) throw new Error("sign-in was not started");
  return run;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("the sign_in tool", () => {
  it("is unavailable without a sign-in source, and waits while the screen is someone else's", async () => {
    expect(await callTool(fakeCtx({ signInSource: false }).ctx)).toEqual({
      error: "Signing in with a password manager is unavailable.",
    });
    vi.mocked(Computer.screenBlocked).mockResolvedValueOnce("Teaching is in progress.");
    expect(await callTool(fakeCtx().ctx)).toEqual({ error: "Teaching is in progress." });
    expect(Requests.signIn).not.toHaveBeenCalled();
  });

  it("fills through the computer's browser only when that browser has the extension", async () => {
    const signInFill = vi.fn(async () => ({ status: "submitted" }));
    const browser = { signInFill, canSignInFill: () => true };
    expect(await callTool(fakeCtx({ browser }).ctx)).toBe("signed");
    const call = { method: "m", params: {} };
    await handedRun().fill?.fill({ origin: card.site, call }, {} as never);
    expect(signInFill).toHaveBeenCalledWith(COMPUTER, { origin: card.site, call }, {});

    await callTool(fakeCtx({ browser: { signInFill, canSignInFill: () => false } }).ctx);
    expect(handedRun().fill).toBeUndefined();
    const plain = fakeCtx();
    await callTool(plain.ctx);
    expect(handedRun().fill).toBeUndefined();
    expect(plain.getComputer).not.toHaveBeenCalled();
  });

  it("posts the card, notifies the person of a request, and redraws the card it changes", async () => {
    const { ctx } = fakeCtx();
    await callTool(ctx);
    const run = handedRun();
    expect(await run.postCard(card)).toEqual({ messageId: "message-1" });
    expect(Messages.publishMessage).toHaveBeenCalledWith(ctx.deps, ctx.run, "bot", [card]);
    expect(Notifications.notifyRun).toHaveBeenCalledTimes(1);
    await run.postCard({ ...card, status: "needs_connection", requestId: undefined });
    expect(Notifications.notifyRun).toHaveBeenCalledTimes(1);
    await run.updateCard("message-1", (block) => ({ ...block, status: "approved" }));
    expect(Db.changeSignInBlock).toHaveBeenCalledWith(
      ctx.deps.prisma,
      { spaceId: "space-1", threadId: "thread-1", messageId: "message-1" },
      expect.any(Function),
    );
    expect(ctx.deps.events.notify).toHaveBeenCalledWith("thread-1", 7);
  });

  it("learns the review was opened from the card or the thread's own update, never by polling", async () => {
    const opened = fakeCtx({ blocks: [{ ...card, opened: true }] });
    await callTool(opened.ctx);
    expect(await handedRun().waitForOpen("message-1", new AbortController().signal)).toBe(true);
    expect(opened.ctx.deps.events.follow).not.toHaveBeenCalled();

    const signalled = fakeCtx({
      follow: async function* () {
        yield { type: "thread.message.updated", payload: { messageId: "other", blocks: [] } };
        yield {
          type: "thread.message.updated",
          payload: { messageId: "message-1", blocks: [{ ...card, opened: true }] },
        };
      },
    });
    await callTool(signalled.ctx);
    expect(await handedRun().waitForOpen("message-1", new AbortController().signal)).toBe(true);
    expect(signalled.ctx.deps.events.follow).toHaveBeenCalledWith(
      "thread-1",
      3,
      expect.any(AbortSignal),
    );

    const never = fakeCtx();
    await callTool(never.ctx);
    expect(await handedRun().waitForOpen("message-1", AbortSignal.abort())).toBe(false);
  });
});

describe("sign_in selection", () => {
  const names = (signInSourceEnabled: boolean, graphicalToolsAllowed: boolean) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      signInSourceEnabled,
    }).map((tool) => tool.name);

  it("is offered only with a sign-in source and the page browser", () => {
    expect(names(true, true)).toContain("sign_in");
    expect(names(false, true)).not.toContain("sign_in");
    expect(names(true, false)).not.toContain("sign_in");
  });
});
