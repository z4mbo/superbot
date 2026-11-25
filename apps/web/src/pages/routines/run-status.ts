import { t } from "@lingui/core/macro";
import type { RunActivityRow } from "@rakazo/contracts";

/** The text colour a run's status shows in. */
export function statusTone(status: RunActivityRow["status"]): string {
  if (status === "failed") return "text-destructive";
  if (status === "cancelled") return "text-muted-foreground";
  if (status === "completed") return "text-success";
  if (status === "waiting_input" || status === "waiting_takeover") return "text-warning";
  return "text-foreground";
}

/** A run's status in words. */
export function statusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Needs input`;
    case "waiting_takeover":
      return t`Needs takeover`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    default:
      return status;
  }
}
