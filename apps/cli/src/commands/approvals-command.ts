import type { Client } from "@rakazo/cli-client";
import {
  approvalJson,
  approvalLines,
  pendingApprovals,
  resolveApproval,
} from "../approvals/approvals.js";
import { CommandError, hinted } from "../output/errors.js";
import { jsonText, quoted } from "../output/text.js";
import type { Catalog } from "../session/catalog.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";

export type ApprovalAnswer = { id: string; answer: "allow" | "deny" };

/** `superbot approvals [allow|deny ID]`: lists the waiting cards, or answers one by its ID. */
export async function approvalsCommand(
  io: Io,
  client: Client,
  catalog: Catalog,
  command: ApprovalAnswer | undefined,
  json: boolean,
): Promise<void> {
  const found = await hinted(pendingApprovals(client, catalog));
  if (command === undefined) {
    if (json) {
      line(io, jsonText(found.map(approvalJson)));
      return;
    }
    if (found.length === 0) line(io, "No approvals are waiting.");
    for (const approval of found) io.out(approvalLines(approval));
    return;
  }
  const approval = found.find((entry) => entry.id === command.id.trim());
  if (!approval) {
    throw new CommandError(
      `No approval ${quoted(command.id)} is waiting. Run superbot approvals to list them.`,
    );
  }
  const outcome = await hinted(resolveApproval(client, approval, command.answer));
  if (outcome !== "answered") {
    throw new CommandError("This approval is no longer awaiting an answer.");
  }
  line(io, command.answer === "allow" ? "Allowed." : "Denied.");
}
