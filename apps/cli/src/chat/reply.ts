/**
 * Live replies: one reducer turns thread events into display updates for the line chat, `send`,
 * and the full-screen view.
 */
import type { ChatMessage, ThreadEvent } from "@rakazo/cli-client";
import { eventMessage } from "@rakazo/cli-client";

export type RunEnd =
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" }
  | { kind: "waitingInput" };

export type Update =
  /** Text the agent is writing now, to append to what is already shown. */
  | { kind: "draft"; delta: string }
  /** The text written so far will not be in the reply. */
  | { kind: "draftWithdrawn" }
  /** What the agent is doing while no text streams, or undefined once it stops. */
  | { kind: "activity"; text: string | undefined }
  | { kind: "message"; message: ChatMessage }
  | { kind: "runEnded"; runId: string; end: RunEnd }
  | { kind: "cleared" };

const RUN_ENDS: Record<string, RunEnd["kind"]> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.waiting_input": "waitingInput",
};

/** Follows one thread's live events. Only one draft streams at a time, as in a direct chat. */
export class Reply {
  #draft = "";

  apply(event: ThreadEvent): Update[] {
    const data = event.payload as Record<string, unknown>;
    const text = (key: string) =>
      typeof data[key] === "string" ? (data[key] as string) : undefined;
    const flag = (key: string) => data[key] === true;
    const updates: Update[] = [];
    switch (event.type) {
      case "thread.progress": {
        if (flag("reset") && this.#draft !== "") {
          this.#draft = "";
          updates.push({ kind: "draftWithdrawn" });
        }
        if (flag("streaming")) {
          const whole = text("text");
          const delta = text("delta");
          let next: string;
          if (whole !== undefined) next = whole;
          else if (delta !== undefined) next = this.#draft + delta;
          else return updates;
          if (next.startsWith(this.#draft)) {
            const added = next.slice(this.#draft.length);
            if (added !== "") updates.push({ kind: "draft", delta: added });
          } else {
            updates.push({ kind: "draftWithdrawn" });
            updates.push({ kind: "draft", delta: next });
          }
          this.#draft = next;
        } else {
          const status = text("text")?.trim();
          if (status) updates.push({ kind: "activity", text: status });
        }
        break;
      }
      case "thread.meta": {
        const activity = data.activity;
        const thinking =
          typeof activity === "object" && activity !== null
            ? (activity as { thinking?: unknown }).thinking
            : undefined;
        if (typeof thinking === "boolean") {
          updates.push({ kind: "activity", text: thinking ? "Thinking…" : undefined });
        }
        break;
      }
      case "thread.message.created":
      case "thread.message.updated": {
        const message = eventMessage(event);
        if (message) {
          if (message.role === "bot" && message.text !== "") this.#draft = "";
          updates.push({ kind: "message", message });
        }
        break;
      }
      case "thread.cleared":
        this.#draft = "";
        updates.push({ kind: "cleared" });
        break;
      default: {
        const ending = RUN_ENDS[event.type];
        if (!ending) break;
        this.#draft = "";
        updates.push({ kind: "activity", text: undefined });
        if (event.runId) {
          const end: RunEnd =
            ending === "failed"
              ? { kind: "failed", reason: failureReason(data) }
              : { kind: ending };
          updates.push({ kind: "runEnded", runId: event.runId, end });
        }
      }
    }
    return updates;
  }
}

function failureReason(payload: Record<string, unknown>): string {
  const error = payload.error;
  const reason =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed === "" ? "No failure details were provided." : trimmed;
}

/** Who wrote a message, as the transcript names them. */
export function speaker(
  agentName: string,
  role: string,
  author: { name: string } | null | undefined,
): string {
  if (role === "user") return author?.name ?? "Member";
  if (role === "bot") return agentName;
  return "Superbot";
}
