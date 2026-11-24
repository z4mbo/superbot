import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation, reserveBotEmailSend } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

export const BOT_EMAIL_SUBJECT_MAX_CHARS = 500;
const MAX_REFERENCES = 20;

/** The thread a reply joins: its default subject and the headers that keep it in that thread. */
export function emailReplyThreading(original: {
  subject: string;
  messageId: string | null;
  references: string[];
}): { subject: string; parent: string | undefined; references: string[] } {
  // A reply to mail the bot sent answers what that one answered: its own ID is the provider's.
  return {
    subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
    parent: original.messageId ?? original.references.at(-1),
    references: original.messageId
      ? [...original.references, original.messageId].slice(-MAX_REFERENCES)
      : original.references,
  };
}

/** A subject as one header line, within the limit. */
export function emailSubjectLine(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").slice(0, BOT_EMAIL_SUBJECT_MAX_CHARS);
}

export type BotEmailSendResult =
  | { sent: true; id: string }
  /** The owner's allowance or settings refused it; nothing was sent. */
  | { refused: Exclude<Awaited<ReturnType<typeof reserveBotEmailSend>>, { id: string }> }
  /** A send under this key started before; it may or may not have gone out. */
  | { earlier: string }
  /** The provider refused or failed it; it most likely did not go out. */
  | { failed: unknown };

/**
 * Sends one email from the bot's own address and keeps a copy in its inbox under `key`. The copy
 * is saved before the email goes, so a key is sent at most once: a retry after a crash, or a
 * second process racing this one, finds it and sends nothing.
 */
export async function sendBotEmail(
  deps: { prisma: PrismaClient; email: TransactionalEmailProvider },
  input: {
    bot: { id: string; userId: string; spaceId: string; name: string };
    address: string;
    key: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    /** The Message-ID answered and the thread's References, for a reply. */
    parent?: string;
    references?: string[];
    /** A recent, authenticated sender the bot may answer although no setting approves them. */
    verifiedReplySender?: string;
  },
): Promise<BotEmailSendResult> {
  const { prisma } = deps;
  const { bot, key } = input;
  const cc = input.cc ?? [];
  const references = input.references ?? [];
  const earlier = await prisma.botEmailMessage.findUnique({
    where: { botId_key: { botId: bot.id, key } },
    select: { id: true },
  });
  if (earlier) return { earlier: earlier.id };
  const reserved = await reserveBotEmailSend(prisma, {
    userId: bot.userId,
    botId: bot.id,
    recipients: [...input.to, ...cc],
    verifiedReplySender: input.verifiedReplySender,
  });
  if (typeof reserved === "string") return { refused: reserved };
  let row: { id: string };
  try {
    row = await prisma.botEmailMessage.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        key,
        references,
        fromAddress: input.address,
        fromName: bot.name,
        verified: true,
        sent: true,
        to: input.to,
        cc,
        subject: input.subject,
        text: input.text,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await prisma.botEmailMessage.findUniqueOrThrow({
      where: { botId_key: { botId: bot.id, key } },
      select: { id: true },
    });
    return { earlier: winner.id };
  }
  try {
    await deps.email.send({
      from: `"${bot.name.replace(/["\\\r\n]/g, "")}" <${input.address}>`,
      replyTo: input.address,
      to: input.to,
      ...(cc.length ? { cc } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.parent
        ? { headers: { "In-Reply-To": input.parent, References: references.join(" ") } }
        : {}),
    });
  } catch (error) {
    // Most failures are refusals, but one can come after the provider took the email, so the
    // reserved send keeps counting toward the daily limits either way.
    await bestEffort(
      "remove the copy of an email that was not sent",
      prisma.botEmailMessage.delete({ where: { id: row.id } }),
    );
    return { failed: error };
  }
  return { sent: true, id: row.id };
}
