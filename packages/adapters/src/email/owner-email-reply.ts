import type { JobPublisher, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ownerEmailReplyJob, ownerEmailReplyJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { repliesText } from "../messaging/reply-text.js";
import { isExactNoResponse } from "../runs/assembly/silent-reply.js";
import { emailReplyThreading, emailSubjectLine, sendBotEmail } from "./bot-email-send.js";

/**
 * How long after a run's completion its backup mails the answer, should the process that
 * finished the run stop before sending it: well past one send's own timeout.
 */
export const OWNER_EMAIL_REPLY_BACKUP_MS = 3 * 60_000;
const REPLY_TEXT_MAX_CHARS = 20_000;

export type OwnerEmailReplyDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "cancel">;
  /** Sends a bot's email from its own address; absent when this server sends no email. */
  email?: TransactionalEmailProvider;
  inboundEmailDomain?: string;
};

type ReplyRun = { id: string; trigger: string; sourceMessageId: string | null };

/** The owner's email in the bot's inbox that started this run and gets its answer, if any. */
async function emailReplyTo(prisma: PrismaClient, run: ReplyRun): Promise<string | undefined> {
  // Only the inbound path writes this block, and only for the owner's own verified mail.
  if (run.trigger !== "webhook" || !run.sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: { id: true, blocks: true },
  });
  if (!source) return undefined;
  for (const block of storedMessageBlocks(source))
    if (block.kind === "delivery") return block.emailReplyTo;
  return undefined;
}

/**
 * Before a run's completion commits: when the run answers the owner's email, schedule the backup
 * that mails the answer should this process stop after the commit. Returns whether to mail it.
 * A run that chose silence, or a server that sends no email, mails nothing.
 */
export async function scheduleOwnerEmailReply(
  deps: OwnerEmailReplyDeps,
  run: ReplyRun,
  answered: boolean,
): Promise<boolean> {
  if (!(await emailReplyTo(deps.prisma, run))) return false;
  if (!answered) {
    // An earlier attempt of this run may have scheduled one before it stopped.
    await deps.jobs.cancel(ownerEmailReplyJobKey(run.id));
    return false;
  }
  if (!deps.email || !deps.inboundEmailDomain) {
    getLogger().info("owner email reply skipped", {
      reason: "no outbound email",
      "run.id": run.id,
    });
    return false;
  }
  await deps.jobs.enqueue(
    ownerEmailReplyJob(run.id, new Date(Date.now() + OWNER_EMAIL_REPLY_BACKUP_MS)),
  );
  return true;
}

/**
 * After the run's completion commits, in the process that finished it: mail the answer now.
 * Never fails the run. Done or refused, the backup goes; a failed send hands it the retries.
 */
export async function sendOwnerEmailReplyNow(
  deps: OwnerEmailReplyDeps,
  runId: string,
): Promise<void> {
  try {
    await replyToOwnerEmail(deps, runId);
  } catch (error) {
    getLogger().warn("owner email reply failed; its backup job retries", {
      "run.id": runId,
      "error.message": error instanceof Error ? error.message : String(error),
    });
    await bestEffort(
      "move up an owner email reply's backup",
      deps.jobs.enqueue(ownerEmailReplyJob(runId)),
    );
    return;
  }
  await bestEffort(
    "cancel a sent owner email reply's backup",
    deps.jobs.cancel(ownerEmailReplyJobKey(runId)),
  );
}

export type OwnerEmailReplyOutcome = "sent" | "skipped";

/**
 * Mails a completed run's answer to the owner's email that started it, as a reply in that thread.
 * Sends at most once per run, and never when the run itself already wrote to the sender. Throws
 * only when the provider failed the send, so the backup job tries again.
 */
export async function replyToOwnerEmail(
  deps: Pick<OwnerEmailReplyDeps, "prisma" | "email" | "inboundEmailDomain">,
  runId: string,
): Promise<OwnerEmailReplyOutcome> {
  const { prisma } = deps;
  const skipped = (reason: string) => {
    // Logged without addresses or content.
    getLogger().info("owner email reply skipped", { reason, "run.id": runId });
    return "skipped" as const;
  };
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      trigger: true,
      userId: true,
      sourceMessageId: true,
      bot: { select: { id: true, userId: true, spaceId: true, name: true } },
    },
  });
  if (run?.status !== "completed") return "skipped";
  const emailId = await emailReplyTo(prisma, run);
  if (!emailId) return "skipped";
  const { bot } = run;
  // The owner's run of the owner's bot: no one else's work is mailed to them.
  if (run.userId !== bot.userId) return skipped("not the owner's run");
  if (!deps.email || !deps.inboundEmailDomain) return skipped("no outbound email");

  const inbound = await prisma.botEmailMessage.findFirst({
    where: { id: emailId, botId: bot.id, sent: false },
    select: {
      subject: true,
      messageId: true,
      references: true,
      fromAddress: true,
      verified: true,
    },
  });
  // Deleted from the inbox since, or never signed: the answer stays in the app.
  if (!inbound?.verified) return skipped("no verified email to answer");
  // Checked again here, not only when the mail arrived: an owner who changed their address, or
  // lost its confirmation, gets nothing at the old one.
  const owner = await prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true, emailVerified: true, deactivatedAt: true },
  });
  const sender = inbound.fromAddress.trim().toLowerCase();
  if (!owner?.emailVerified || owner.deactivatedAt || owner.email.trim().toLowerCase() !== sender) {
    return skipped("sender is not the owner");
  }
  const name = await prisma.botEmailAddress.findUnique({
    where: { botId: bot.id },
    select: { name: true },
  });
  if (!name) return skipped("bot has no address");

  // The bot already wrote to the sender in this run, or answered in this thread: once is enough.
  const ownSends = await prisma.botEmailMessage.findMany({
    where: { botId: bot.id, sent: true, key: { startsWith: `sent:${run.id}:` } },
    select: { to: true, cc: true, references: true },
  });
  if (
    ownSends.some(
      (sent) =>
        (inbound.messageId !== null && sent.references.includes(inbound.messageId)) ||
        [...sent.to, ...sent.cc].some((address) => address.trim().toLowerCase() === sender),
    )
  ) {
    return skipped("already answered by email");
  }

  const messages = await prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { id: true, blocks: true },
  });
  const answer = repliesText(messages);
  if (!answer || isExactNoResponse(answer)) return skipped("no answer");
  const text =
    answer.length > REPLY_TEXT_MAX_CHARS ? `${answer.slice(0, REPLY_TEXT_MAX_CHARS - 1)}…` : answer;

  const thread = emailReplyThreading(inbound);
  const result = await sendBotEmail(
    { prisma, email: deps.email },
    {
      bot,
      address: `${name.name}@${deps.inboundEmailDomain}`,
      key: `reply:${run.id}`,
      // The sender's own mailbox, as their account names it: the one address the allowance
      // always approves, and no one else's.
      to: [owner.email.trim()],
      subject: emailSubjectLine(thread.subject),
      text,
      parent: thread.parent,
      references: thread.references,
    },
  );
  if ("sent" in result) return "sent";
  if ("earlier" in result) return skipped("already sent");
  if ("refused" in result) return skipped(`refused: ${result.refused}`);
  throw result.failed instanceof Error
    ? result.failed
    : new Error("owner email reply failed", { cause: result.failed });
}
