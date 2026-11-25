import type { PendingApproval } from "../approvals/approvals.js";
import type { App, RosterBot } from "./state.js";
import { newApp } from "./state.js";

export function bot(id: string, name: string, color: string): RosterBot {
  return { id, name, color, archivedAt: null };
}

export function app(): App {
  return newApp({ id: "space-1", name: "Personal" });
}

export function pending(id: string): PendingApproval {
  return {
    id,
    spaceId: "space-1",
    spaceName: "Personal",
    agentId: "bot-1",
    agentName: "Fixture agent",
    threadId: "thread-1",
    conversation: undefined,
    runId: "run-1",
    title: "Allow web_fetch?",
    site: undefined,
    detail: undefined,
  };
}
