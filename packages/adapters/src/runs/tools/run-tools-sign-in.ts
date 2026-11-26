import type { SignInFillPort } from "@rakazo/adapter-kit";
import type { SignInBlock } from "@rakazo/contracts";
import { BotSecretAuth, SignInBlockSchema } from "@rakazo/contracts";
import { displayName } from "@rakazo/core";
import { changeSignInBlock } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { usableVaultFields } from "../../secrets/vault/vault-access.js";
import type { SignInRun } from "../../sign-in-sources/sign-in-requests.js";
import { signIn } from "../../sign-in-sources/sign-in-requests.js";
import type { RunContext } from "../assembly/run-context.js";
import { publishMessage } from "../assembly/run-messages.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import { screenBlocked } from "./run-tools-computer.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** A saved login this bot may use on `origin`: it wins over asking the password manager. */
async function vaultLoginFor(ctx: RunContext, origin: string): Promise<string | undefined> {
  const { prisma } = ctx.deps;
  const rows = await prisma.vaultCredential.findMany({
    where: {
      AND: [
        await usableVaultFields(prisma, { ...ctx.run, botId: ctx.bot.id }),
        { OR: [{ origin }, { alsoOn: { has: origin } }] },
      ],
    },
    select: { name: true, auth: true },
    orderBy: { updatedAt: "desc" },
  });
  return rows.find((row) => BotSecretAuth.safeParse(row.auth).data?.type === "login")?.name;
}

/** Waits for the card's review to be opened, from the thread's own update signals. */
async function waitForOpen(ctx: RunContext, messageId: string, signal: AbortSignal) {
  const { deps, run } = ctx;
  const opened = (blocks: unknown) =>
    Array.isArray(blocks) &&
    blocks.some((block) => SignInBlockSchema.safeParse(block).data?.opened === true);
  const cursor =
    (
      await deps.prisma.event.findFirst({
        where: { threadId: run.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      })
    )?.seq ?? 0;
  // Opened before the wait began: the row already says so.
  const message = await deps.prisma.message.findFirst({
    where: { id: messageId, threadId: run.threadId },
    select: { blocks: true },
  });
  if (opened(message?.blocks)) return true;
  try {
    for await (const event of deps.events.follow(run.threadId, cursor, signal)) {
      if (event.type !== "thread.message.updated" || event.payload.messageId !== messageId)
        continue;
      if (opened(event.payload.blocks)) return true;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  return false;
}

/** The computer's browser fill, absent when its browser has no sign-in extension. */
async function fillPort(ctx: RunContext): Promise<SignInFillPort | undefined> {
  const browser = ctx.providers.browser;
  const signInFill = browser.signInFill?.bind(browser);
  if (!signInFill) return undefined;
  const computer = await ctx.computer.get("tool", "sign_in");
  if (browser.canSignInFill?.(computer) === false) return undefined;
  return { fill: (request, context) => signInFill(computer, request, context) };
}

async function signInRun(ctx: RunContext): Promise<SignInRun | undefined> {
  const { deps, run, bot } = ctx;
  const signInSource = deps.signInSource;
  if (!signInSource) return undefined;
  const fill = await fillPort(ctx);
  const ref = (messageId: string) => ({ spaceId: run.spaceId, threadId: run.threadId, messageId });
  return {
    deps: {
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      signInSource,
    },
    actor: { userId: run.userId, spaceId: run.spaceId },
    bot: { id: bot.id, name: bot.name },
    runId: run.id,
    threadId: run.threadId,
    context: ctx.context,
    fill,
    vaultLoginFor: (origin) => vaultLoginFor(ctx, origin),
    postCard: async (block: SignInBlock) => {
      const message = await publishMessage(deps, run, "bot", [block]);
      if (!message) return null;
      if (block.status === "pending")
        // As for any question the run asks: the person may be elsewhere.
        await bestEffort(
          "sign-in request notification",
          notifyRun(deps, run, {
            kind: "help",
            title: `${displayName(bot.name, "Bot")} needs to sign in`,
            body: block.site,
            botId: run.botId,
            threadId: run.threadId,
          }),
        );
      return { messageId: message.id };
    },
    updateCard: async (messageId, change) => {
      const { seq } = await changeSignInBlock(deps.prisma, ref(messageId), change);
      if (seq !== undefined) await bestEffort("sign-in card", deps.events.notify(run.threadId, seq));
    },
    waitForOpen: (messageId, signal) => waitForOpen(ctx, messageId, signal),
  };
}

async function signInTool(ctx: RunContext, call: ToolCall) {
  if (!ctx.deps.signInSource)
    return call.finish({ error: "Signing in with a password manager is unavailable." });
  const blocked = await screenBlocked(ctx, false);
  if (blocked) return call.finish({ error: blocked });
  const run = await signInRun(ctx);
  if (!run) return call.finish({ error: "Signing in with a password manager is unavailable." });
  return call.finish(await signIn(run, { site: call.args.site }));
}

/** Signing in with the person's password manager, after they approve the login in its app. */
export const signInTools: ToolHandlers = { sign_in: signInTool };
