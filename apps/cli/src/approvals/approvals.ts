import type { Client } from "@rakazo/cli-client";
import { describeError, hasStatus, isUnauthorized } from "../output/errors.js";
import { terminalText, textLines } from "../output/text.js";
import type { Catalog } from "../session/catalog.js";
import { agentsIn } from "../session/catalog.js";
import type { Io } from "../terminal/io.js";
import { errorLine, line } from "../terminal/io.js";
import type { AgentThread, Block, Snapshot, SnapshotMessage } from "../threads/thread-api.js";
import { answerCard, botConversations, targetFor, threadSnapshot } from "../threads/thread-api.js";

export type Outcome = "answered" | "leftPending" | "stale";

/** The runs in a snapshot that wait for an answer. */
export function waitingRuns(snapshot: Snapshot): string[] {
  return (snapshot.activeRuns ?? []).flatMap((run) =>
    run.status === "waiting_input" && typeof run.id === "string" ? [run.id] : [],
  );
}

/** A message's text blocks, joined. */
export function messageText(message: SnapshotMessage): string {
  return message.blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Fields of a card that this client cannot show or answer safely. */
const PROTECTED_FIELDS = [
  "receipt",
  "outgoingDraft",
  "instructionUpdate",
  "settingsUpdate",
  "credential",
  "oneTimeCode",
  "loginFields",
];
const CARD_KINDS = new Set([
  "ask",
  "choice",
  "tool_question",
  "mcp_approval",
  "app_connect",
  "connect",
]);

const present = (value: unknown) => value !== undefined && value !== null;

/** An approval card this client can answer: allow once or deny, nothing typed or secret. */
type Approval = {
  messageId: string;
  title: string;
  site: string | undefined;
  detail: string | undefined;
  actions: [allow: { id: string; label: string }, deny: { id: string; label: string }];
};

function pendingAsk(block: Block): boolean {
  return (
    block.kind === "ask" &&
    (!present(block.status) || block.status === "pending") &&
    ["answer", "dismissed", "expired"].every((key) => !present(block[key]))
  );
}

function approvalFrom(message: SnapshotMessage): Approval | undefined {
  const asks = message.blocks.filter(pendingAsk);
  const block = asks[0];
  if (
    !block ||
    asks.length !== 1 ||
    typeof block.approvalEffectId !== "string" ||
    block.approvalEffectId === "" ||
    present(block.input) ||
    PROTECTED_FIELDS.some((key) => present(block[key]))
  ) {
    return undefined;
  }
  if (!Array.isArray(block.actions)) return undefined;
  const actions = block.actions as Array<Record<string, unknown>>;
  const action = (id: string, label: string) => {
    const matches = actions.filter((entry) => entry?.id === id);
    if (matches.length !== 1 || matches[0]?.label !== label) return undefined;
    return { id, label };
  };
  const allow = action("allow", "Allow once");
  const deny = action("deny", "Deny");
  if (typeof block.text !== "string" || !allow || !deny) return undefined;
  return {
    messageId: message.id,
    title: block.text,
    site: typeof block.site === "string" ? block.site : undefined,
    detail: typeof block.detail === "string" ? block.detail : undefined,
    actions: [allow, deny],
  };
}

function card(approval: Approval): string {
  let text = "Approval required\n";
  const detail = (value: string) => {
    for (const row of textLines(terminalText(value))) text += `  ${row}\n`;
  };
  detail(approval.title);
  if (approval.site !== undefined) detail(`Site: ${approval.site}`);
  if (approval.detail !== undefined) detail(approval.detail);
  return text;
}

/** The approval card a waiting run shows, when it is one this client can answer. */
function approvalIn(snapshot: Snapshot, runId: string): Approval | undefined {
  let latest: SnapshotMessage | undefined;
  for (const message of snapshot.messages) {
    if (
      message.runId === runId &&
      message.role === "bot" &&
      message.blocks.some(
        (block) => typeof block.kind === "string" && CARD_KINDS.has(block.kind),
      ) &&
      (!latest || message.seq >= latest.seq)
    ) {
      latest = message;
    }
  }
  return latest && approvalFrom(latest);
}

/** A card waiting on the signed-in person, wherever it is in the selected Spaces. */
export type PendingApproval = {
  /** The card's message ID, which `approvals allow` and `approvals deny` take. */
  id: string;
  spaceId: string;
  spaceName: string;
  agentId: string;
  agentName: string;
  threadId: string;
  /** Set for an added conversation; the agent's first conversation leaves it out. */
  conversation: string | undefined;
  runId: string;
  title: string;
  site: string | undefined;
  detail: string | undefined;
};

export function approvalTarget(approval: PendingApproval): AgentThread {
  return targetFor(approval.agentId, approval.conversation);
}

/** The approval as `approvals --json` lists it. */
export function approvalJson(approval: PendingApproval): Record<string, string> {
  const listed: Record<string, string> = {
    id: approval.id,
    spaceId: approval.spaceId,
    spaceName: approval.spaceName,
    agentId: approval.agentId,
    agentName: approval.agentName,
    threadId: approval.threadId,
    runId: approval.runId,
    title: approval.title,
  };
  if (approval.site !== undefined) listed.site = approval.site;
  if (approval.detail !== undefined) listed.detail = approval.detail;
  return listed;
}

/** The text form of a card in a list: where it is, then what it asks. */
export function approvalLines(approval: PendingApproval): string {
  let text = `${approval.id}  ${terminalText(approval.spaceName)} / ${terminalText(approval.agentName)}\n`;
  for (const row of textLines(terminalText(approval.title))) text += `  ${row}\n`;
  if (approval.site !== undefined) text += `  Site: ${terminalText(approval.site)}\n`;
  return text;
}

/** Collects the waiting approvals in one conversation's snapshot. */
export function pendingIn(
  snapshot: Snapshot,
  space: { id: string; name: string },
  agent: { id: string; name: string },
  conversation: string | undefined,
): PendingApproval[] {
  return waitingRuns(snapshot).flatMap((runId) => {
    const approval = approvalIn(snapshot, runId);
    if (!approval) return [];
    return [
      {
        id: approval.messageId,
        spaceId: space.id,
        spaceName: space.name,
        agentId: agent.id,
        agentName: agent.name,
        threadId: snapshot.threadId,
        conversation,
        runId,
        title: approval.title,
        site: approval.site,
        detail: approval.detail,
      },
    ];
  });
}

/**
 * Reads every open conversation of every agent in the catalog, agents side by side, and returns
 * the approvals waiting in them.
 */
export async function pendingApprovals(
  client: Client,
  catalog: Catalog,
): Promise<PendingApproval[]> {
  const found = await Promise.all(
    agentsIn(catalog).map(async ({ space, agent }) => {
      const first = await threadSnapshot(client, space.id, targetFor(agent.id));
      const approvals = pendingIn(first, space, agent, undefined);
      for (const conversation of await botConversations(client, space.id, agent.id)) {
        if (conversation.archivedAt || conversation.threadId === first.threadId) continue;
        const snapshot = await threadSnapshot(
          client,
          space.id,
          targetFor(agent.id, conversation.threadId),
        );
        approvals.push(...pendingIn(snapshot, space, agent, conversation.threadId));
      }
      return approvals;
    }),
  );
  return found.flat();
}

/** Answers a listed card with `allow` or `deny`. */
export async function resolveApproval(
  client: Client,
  approval: PendingApproval,
  answer: "allow" | "deny",
): Promise<Outcome> {
  try {
    await answerCard(
      client,
      approval.spaceId,
      approvalTarget(approval),
      approval.runId,
      approval.id,
      answer,
    );
    return "answered";
  } catch (error) {
    if (hasStatus(error, 409)) return "stale";
    throw error;
  }
}

/** Prints the card for a reply that stopped on it, with the commands that answer it. */
export function printWaiting(io: Io, snapshot: Snapshot, runId: string): void {
  const approval = approvalIn(snapshot, runId);
  if (!approval) {
    errorLine(io, "The agent is waiting for input. Open Superbot to answer this card.");
    return;
  }
  io.err(card(approval));
  errorLine(
    io,
    `Answer with superbot approvals allow ${approval.messageId} or superbot approvals deny ${approval.messageId}`,
  );
}

/** The waiting card as `send --json` reports it, or null when this client cannot answer it. */
export function waitingJson(snapshot: Snapshot, runId: string): unknown {
  const approval = approvalIn(snapshot, runId);
  if (!approval) return null;
  return {
    id: approval.messageId,
    title: approval.title,
    site: approval.site ?? null,
    detail: approval.detail ?? null,
  };
}

/**
 * Shows the card a waiting run stopped on and, in an interactive terminal, asks for `1` (allow
 * once) or `2` (deny). Anything else, end of input or redirected input leaves it pending.
 */
export async function offerApproval(
  io: Io,
  client: Client,
  spaceId: string,
  target: AgentThread,
  snapshot: Snapshot,
  runId: string,
  interactive: boolean,
  read: () => Promise<string | null>,
): Promise<Outcome> {
  if (!waitingRuns(snapshot).includes(runId)) return "stale";
  const approval = approvalIn(snapshot, runId);
  if (!approval) {
    errorLine(io, "The agent is waiting for input. Open Superbot to answer this card.");
    return "leftPending";
  }
  io.out(card(approval));
  approval.actions.forEach(({ label }, index) => {
    line(io, `  ${index + 1}. ${terminalText(label)}`);
  });
  if (!interactive) {
    errorLine(io, "Approval left pending. Reopen the chat in an interactive terminal to answer.");
    return "leftPending";
  }
  let decision: string | null;
  try {
    decision = await read();
  } catch (error) {
    errorLine(io, `Could not read the approval choice. ${terminalText(describeError(error))}`);
    return "leftPending";
  }
  const choice = decision?.trim();
  const selected =
    choice === "1" ? approval.actions[0].id : choice === "2" ? approval.actions[1].id : undefined;
  if (selected === undefined) {
    errorLine(io, "Approval left pending.");
    return "leftPending";
  }
  try {
    await answerCard(client, spaceId, target, runId, approval.messageId, selected);
    return "answered";
  } catch (error) {
    if (!isUnauthorized(error) && hasStatus(error, 409)) {
      errorLine(io, "This approval is no longer awaiting an answer.");
      return "leftPending";
    }
    throw error;
  }
}
