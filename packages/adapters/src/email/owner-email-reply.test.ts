import { ownerEmailReplyJob, ownerEmailReplyJobKey } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { EmailEmulator } from "./email-emulator.js";
import type { OwnerEmailReplyDeps } from "./owner-email-reply.js";
import {
  OWNER_EMAIL_REPLY_BACKUP_MS,
  replyToOwnerEmail,
  scheduleOwnerEmailReply,
  sendOwnerEmailReplyNow,
} from "./owner-email-reply.js";

type MailRow = {
  id: string;
  botId: string;
  key: string;
  sent: boolean;
  verified: boolean;
  messageId: string | null;
  references: string[];
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
};

const INBOUND: MailRow = {
  id: "in-1",
  botId: "bot-1",
  key: "<m-2@example.test>",
  sent: false,
  verified: true,
  messageId: "<m-2@example.test>",
  references: ["<m-0@example.test>", "<bot-1@bots.test>"],
  fromAddress: "owner@example.test",
  to: ["scout@bots.test"],
  cc: [],
  subject: "Flights for Friday",
  text: "Which flight should I take?",
};

function setup(
  options: {
    inbound?: Partial<MailRow> | null;
    run?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
    owner?: Record<string, unknown>;
    answers?: string[];
    /** Mail this run already sent itself with send_email. */
    ownSends?: Array<Partial<MailRow>>;
    noProvider?: boolean;
    dailyLimit?: number;
  } = {},
) {
  const mail: MailRow[] = [];
  if (options.inbound !== null) mail.push({ ...INBOUND, ...options.inbound });
  for (const [index, sent] of (options.ownSends ?? []).entries()) {
    mail.push({
      ...INBOUND,
      id: `own-${index}`,
      key: `sent:run-1:send_email:${index}`,
      sent: true,
      fromAddress: "scout@bots.test",
      to: [],
      ...sent,
    });
  }
  const sends: Array<{ recipientCount: number }> = [];
  const owner = {
    email: "Owner@Example.test",
    emailVerified: true,
    deactivatedAt: null,
    botEmailDailyLimit: options.dailyLimit ?? 10,
    botEmailRepliesEnabled: false,
    botEmailAllowedRecipients: [],
    ...options.owner,
  };
  const user = { findUnique: async () => owner };
  const botEmailSend = {
    deleteMany: async () => ({ count: 0 }),
    aggregate: async () => ({
      _sum: { recipientCount: sends.reduce((total, row) => total + row.recipientCount, 0) },
    }),
    create: async ({ data }: { data: { recipientCount: number } }) => {
      sends.push(data);
      return { id: `send-${sends.length}` };
    },
  };
  const byKey = ({ where }: { where: { botId_key: { botId: string; key: string } } }) =>
    mail.find((row) => row.botId === where.botId_key.botId && row.key === where.botId_key.key) ??
    null;
  const prisma = {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: async () => [], botEmailSend, user }),
    user,
    botEmailSend,
    run: {
      findUnique: async () => ({
        id: "run-1",
        status: "completed",
        trigger: "webhook",
        userId: "owner-1",
        sourceMessageId: "msg-in",
        bot: { id: "bot-1", userId: "owner-1", spaceId: "space-1", name: "Scout" },
        ...options.run,
      }),
    },
    message: {
      findUnique: async () => ({
        id: "msg-in",
        blocks: [
          { kind: "delivery", emailReplyTo: "in-1", ...options.delivery },
          { kind: "text", text: "[Email from your owner]" },
        ],
      }),
      findMany: async () =>
        (options.answers ?? ["Take the 9:40, it lands before noon."]).map((text, index) => ({
          id: `reply-${index}`,
          blocks: [
            { kind: "steps", steps: [] },
            { kind: "text", text },
          ],
        })),
    },
    botEmailAddress: { findUnique: async () => ({ name: "scout" }) },
    botEmailMessage: {
      findFirst: async ({ where }: { where: { id: string; botId: string; sent: boolean } }) =>
        mail.find(
          (row) => row.id === where.id && row.botId === where.botId && row.sent === where.sent,
        ) ?? null,
      findMany: async ({
        where,
      }: {
        where: { botId: string; sent: boolean; key: { startsWith: string } };
      }) =>
        mail.filter(
          (row) =>
            row.botId === where.botId &&
            row.sent === where.sent &&
            row.key.startsWith(where.key.startsWith),
        ),
      findUnique: async (args: { where: { botId_key: { botId: string; key: string } } }) =>
        byKey(args),
      findUniqueOrThrow: async (args: { where: { botId_key: { botId: string; key: string } } }) =>
        byKey(args)!,
      create: async ({ data }: { data: Omit<MailRow, "id"> }) => {
        // The (botId, key) unique index.
        if (mail.some((row) => row.botId === data.botId && row.key === data.key))
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { ...data, id: `sent-${mail.length}` };
        mail.push(row);
        return { id: row.id };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        mail.splice(
          mail.findIndex((row) => row.id === where.id),
          1,
        );
      },
    },
  };
  const email = new EmailEmulator();
  const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
  const deps: OwnerEmailReplyDeps = {
    prisma: prisma as unknown as OwnerEmailReplyDeps["prisma"],
    jobs,
    ...(options.noProvider ? {} : { email, inboundEmailDomain: "bots.test" }),
  };
  const replies = () => mail.filter((row) => row.key === "reply:run-1");
  return { deps, email, jobs, sends, replies };
}

describe("owner email reply", () => {
  it("mails the run's answer to the owner once, in the thread they wrote in", async () => {
    const { deps, email, replies } = setup();

    expect(await replyToOwnerEmail(deps, "run-1")).toBe("sent");

    expect(email.sent).toEqual([
      {
        from: '"Scout" <scout@bots.test>',
        replyTo: "scout@bots.test",
        // The sender's mailbox, as the owner's account names it.
        to: ["Owner@Example.test"],
        subject: "Re: Flights for Friday",
        text: "Take the 9:40, it lands before noon.",
        headers: {
          "In-Reply-To": "<m-2@example.test>",
          // The earlier chain, then the message answered.
          References: "<m-0@example.test> <bot-1@bots.test> <m-2@example.test>",
        },
      },
    ]);
    // The bot keeps a copy, so the next mail in the thread finds what it answered.
    expect(replies()).toEqual([
      expect.objectContaining({
        sent: true,
        references: ["<m-0@example.test>", "<bot-1@bots.test>", "<m-2@example.test>"],
      }),
    ]);
  });

  it("keeps an existing Re: subject and joins every message the run posted", async () => {
    const { deps, email } = setup({
      inbound: { subject: "RE: Flights for Friday", references: [] },
      answers: ["Checking the airline now.", "Take the 9:40."],
    });

    await replyToOwnerEmail(deps, "run-1");

    expect(email.sent[0]).toMatchObject({
      subject: "RE: Flights for Friday",
      text: "Checking the airline now.\n\nTake the 9:40.",
      headers: { "In-Reply-To": "<m-2@example.test>", References: "<m-2@example.test>" },
    });
  });

  it("never mails anyone but the owner, or for a run that is not theirs", async () => {
    const cases: Array<Parameters<typeof setup>[0]> = [
      // Mail the inbound path did not mark: a routine, a stranger, or a webhook.
      { delivery: { emailReplyTo: undefined } },
      { run: { trigger: "user" } },
      // A stranger's mail, however it was marked, or one whose signature failed.
      { inbound: { fromAddress: "someone@example.test" } },
      { inbound: { verified: false } },
      // The bot's own sent mail is never a thread to answer.
      { inbound: { sent: true } },
      // The owner changed or lost their confirmed address since.
      { owner: { email: "new@example.test" } },
      { owner: { emailVerified: false } },
      { owner: { deactivatedAt: new Date() } },
      // Another member's run of this bot.
      { run: { userId: "member-2" } },
      // Not finished, or failed.
      { run: { status: "running" } },
      { run: { status: "failed" } },
    ];
    for (const options of cases) {
      const { deps, email } = setup(options);
      expect(await replyToOwnerEmail(deps, "run-1")).toBe("skipped");
      expect(email.sent).toEqual([]);
    }
  });

  it("sends nothing when the run already answered by email or chose silence", async () => {
    const threaded = setup({
      ownSends: [{ to: ["owner@example.test"], references: ["<m-2@example.test>"] }],
    });
    const toOwner = setup({ ownSends: [{ to: ["OWNER@example.test"], references: [] }] });
    const silent = setup({ answers: ["NO_RESPONSE"] });
    const empty = setup({ answers: [""] });
    for (const { deps, email } of [threaded, toOwner, silent, empty]) {
      expect(await replyToOwnerEmail(deps, "run-1")).toBe("skipped");
      expect(email.sent).toEqual([]);
    }

    // Mail the run sent someone else, about something else, does not count as the answer.
    const other = setup({ ownSends: [{ to: ["shop@example.test"], references: [] }] });
    expect(await replyToOwnerEmail(other.deps, "run-1")).toBe("sent");
  });

  it("sends once however often the completion and its backup run", async () => {
    const { deps, email, sends } = setup();

    // The process that finished the run, its backup job, and a retried job.
    const outcomes = await Promise.all([
      replyToOwnerEmail(deps, "run-1"),
      replyToOwnerEmail(deps, "run-1"),
    ]);
    outcomes.push(await replyToOwnerEmail(deps, "run-1"));

    expect(outcomes.filter((outcome) => outcome === "sent")).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    // A send that lost the race still reserved, so the allowance stays on the safe side.
    expect(sends.length).toBeGreaterThanOrEqual(1);
  });

  it("lets a failed send be tried again, and stops at the owner's allowance", async () => {
    const failing = setup();
    failing.email.failNextSends(1);

    await expect(replyToOwnerEmail(failing.deps, "run-1")).rejects.toThrow(
      "Emulated email delivery failure",
    );
    expect(failing.replies()).toEqual([]);
    expect(await replyToOwnerEmail(failing.deps, "run-1")).toBe("sent");
    expect(failing.email.sent).toHaveLength(1);

    const spent = setup({ dailyLimit: 0 });
    expect(await replyToOwnerEmail(spent.deps, "run-1")).toBe("skipped");
    expect(spent.email.sent).toEqual([]);
  });

  it("leaves the answer in the app when this server sends no email", async () => {
    const { deps, jobs } = setup({ noProvider: true });
    const run = { id: "run-1", trigger: "webhook", sourceMessageId: "msg-in" };

    expect(await scheduleOwnerEmailReply(deps, run, true)).toBe(false);
    expect(await replyToOwnerEmail(deps, "run-1")).toBe("skipped");
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("owner email reply delivery", () => {
  const run = { id: "run-1", trigger: "webhook", sourceMessageId: "msg-in" };

  it("schedules the backup before completion, then sends and drops it", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-24T10:00:00.000Z") });
    try {
      const { deps, email, jobs } = setup();

      expect(await scheduleOwnerEmailReply(deps, run, true)).toBe(true);
      expect(jobs.enqueue).toHaveBeenCalledWith(
        ownerEmailReplyJob(
          "run-1",
          new Date(Date.parse("2026-11-24T10:00:00.000Z") + OWNER_EMAIL_REPLY_BACKUP_MS),
        ),
      );

      await sendOwnerEmailReplyNow(deps, "run-1");
      expect(email.sent).toHaveLength(1);
      expect(jobs.cancel).toHaveBeenCalledWith(ownerEmailReplyJobKey("run-1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a failed send to the backup at once, without failing the run", async () => {
    const { deps, email, jobs } = setup();
    email.failNextSends(1);

    await expect(sendOwnerEmailReplyNow(deps, "run-1")).resolves.toBeUndefined();

    expect(jobs.enqueue).toHaveBeenCalledWith(ownerEmailReplyJob("run-1"));
    expect(jobs.cancel).not.toHaveBeenCalled();
  });

  it("schedules nothing for a silent run or a run no email started", async () => {
    const silent = setup();
    expect(await scheduleOwnerEmailReply(silent.deps, run, false)).toBe(false);
    // An earlier attempt's backup goes too.
    expect(silent.jobs.cancel).toHaveBeenCalledWith(ownerEmailReplyJobKey("run-1"));
    expect(silent.jobs.enqueue).not.toHaveBeenCalled();

    const chat = setup({ delivery: { emailReplyTo: undefined } });
    expect(await scheduleOwnerEmailReply(chat.deps, run, true)).toBe(false);
    expect(await scheduleOwnerEmailReply(chat.deps, { ...run, trigger: "user" }, true)).toBe(false);
    expect(chat.jobs.enqueue).not.toHaveBeenCalled();
    expect(chat.jobs.cancel).not.toHaveBeenCalled();
  });
});
