import type { Actor, RpcInput, RpcOutput } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  BACKGROUND_RUN_TRIGGERS,
  HELPER_RESULT_TRIGGER,
  isBackgroundInputBlock,
  WORKING_RUN_STATUSES,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, storedMessageBlocks } from "@rakazo/db";

type Item = RpcOutput<"inbox/list">[number];
type Kind = Item["kind"];
const pageSize = 100;
const phases: Record<Kind, readonly string[]> = {
  question: ["waiting_input", "waiting_takeover"],
  active: WORKING_RUN_STATUSES,
  result: ["completed", "failed", "cancelled"],
};
const kinds = Object.keys(phases) as Kind[];
const groupSelection = {
  select: { _count: { select: { members: { where: { bot: { archivedAt: null } } } } } },
} as const;

function visibleRuns(actor: Actor): Prisma.RunWhereInput {
  const activeBot = { spaceId: actor.spaceId, archivedAt: null };
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    bot: activeBot,
    trigger: {
      notIn: [...BACKGROUND_RUN_TRIGGERS, BACKGROUND_HELPER_TRIGGER, HELPER_RESULT_TRIGGER],
    },
    thread: {
      spaceId: actor.spaceId,
      OR: [
        { bot: activeBot },
        { conversationBot: activeBot },
        { group: { spaceId: actor.spaceId, archivedAt: null } },
      ],
    },
  };
}

function inboxId(kind: Kind, runId: string, sourceKey: string) {
  return sourceKey ? `${kind}:${runId}:${sourceKey}` : `${kind}:${runId}`;
}

function runPhase(kind: Kind): Prisma.RunWhereInput {
  return { status: { in: [...phases[kind]] } };
}

async function sourceMessage(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  runId: string,
  kind: Kind,
) {
  const where = { threadId, runId, role: "bot" };
  const orderBy = { seq: "desc" } as const;
  if (kind === "active") return null;
  if (kind === "result") {
    return prisma.message.findFirst({ where, select: { id: true }, orderBy });
  }
  const messages = await prisma.message.findMany({
    where,
    select: { id: true, blocks: true },
    orderBy,
    take: 10,
  });
  return (
    messages.find((row) =>
      storedMessageBlocks(row).some((block) => {
        if (block.kind === "ask")
          return block.status !== "answered" && !block.expired && !block.dismissed;
        if (block.kind === "tool_question") return block.status === "pending";
        if (block.kind === "sign_in")
          return block.status === "pending" || block.status === "needs_connection";
        return isBackgroundInputBlock(block);
      }),
    ) ?? null
  );
}

export async function listInbox(
  prisma: PrismaClient,
  actor: Actor,
  includeDone: boolean,
): Promise<Item[]> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const runs = await prisma.run.findMany({
    where: {
      ...visibleRuns(actor),
      OR: kinds.map((kind) => ({
        ...runPhase(kind),
        ...(includeDone || kind === "question"
          ? {}
          : {
              inboxReceipts: { none: { ...scope, kind, sourceKey: "", state: "done" } },
            }),
      })),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: pageSize,
    select: {
      id: true,
      status: true,
      botId: true,
      updatedAt: true,
      thread: {
        select: {
          id: true,
          botId: true,
          conversationBotId: true,
          groupId: true,
          group: groupSelection,
        },
      },
      bot: { select: { name: true } },
      inboxReceipts: { where: scope, select: { kind: true, sourceKey: true, state: true } },
      sourceMessage: { select: { id: true, threadId: true } },
    },
  });
  const items = await Promise.all(
    runs
      .filter(({ thread }) => !thread.group || thread.group._count.members >= GROUP_MEMBER_MIN)
      .map(async (run): Promise<Item> => {
        const kind = kinds.find((key) => phases[key].includes(run.status))!;
        const { thread } = run;
        const target: Item["target"] = thread.groupId
          ? { kind: "group", groupId: thread.groupId }
          : thread.conversationBotId
            ? { kind: "botConversation", botId: thread.conversationBotId, threadId: thread.id }
            : { kind: "bot", botId: thread.botId! };
        const message = await sourceMessage(prisma, thread.id, run.id, kind);
        const sourceKey = kind === "question" ? (message?.id ?? "") : "";
        const receipt = run.inboxReceipts.find(
          (row) => row.kind === kind && row.sourceKey === sourceKey,
        )?.state;
        const state = receipt === "read" || receipt === "done" ? receipt : "unread";
        return {
          id: inboxId(kind, run.id, sourceKey),
          kind,
          state,
          target,
          runId: run.id,
          botId: run.botId,
          title: run.bot.name,
          messageId:
            message?.id ??
            (run.sourceMessage?.threadId === thread.id ? run.sourceMessage.id : null),
          updatedAt: run.updatedAt.toISOString(),
        };
      }),
  );
  return includeDone ? items : items.filter(({ state }) => state !== "done");
}

export async function setInboxState(
  prisma: PrismaClient,
  actor: Actor,
  input: RpcInput<"inbox/setState">,
) {
  const kind = kinds.find((key) => input.id.startsWith(`${key}:`));
  if (!kind) throw new IsolationError();
  const [runId] = input.id.slice(kind.length + 1).split(":");
  if (!runId) throw new IsolationError();
  await prisma.$transaction(async (tx) => {
    const run = await tx.run.findFirst({
      where: { ...visibleRuns(actor), ...runPhase(kind), id: runId },
      select: { thread: { select: { id: true, group: groupSelection } } },
    });
    if (!run || (run.thread.group && run.thread.group._count.members < GROUP_MEMBER_MIN)) {
      throw new IsolationError();
    }
    const sourceKey =
      kind === "question" ? ((await sourceMessage(tx, run.thread.id, runId, kind))?.id ?? "") : "";
    if (input.id !== inboxId(kind, runId, sourceKey)) throw new IsolationError();
    const key = { runId, kind, sourceKey, spaceId: actor.spaceId, userId: actor.userId };
    if (input.state === "unread") {
      await tx.inboxReceipt.deleteMany({ where: key });
      return;
    }
    await tx.inboxReceipt.upsert({
      where: { spaceId_userId_runId_kind_sourceKey: key },
      create: { ...key, state: input.state },
      update: { state: input.state },
    });
  });
}
