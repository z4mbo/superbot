import type { AuditEventInput } from "../account/audit-events.js";
import { tryRecordAuditEvent } from "../account/audit-events.js";

/**
 * What happened to a purchase on its card: the order card was shown, its user approved or canceled
 * it, nobody answered in time, or the approved payment went through or failed.
 */
export type PurchaseAuditAction =
  | "purchase.approval_shown"
  | "purchase.approved"
  | "purchase.canceled"
  | "purchase.expired"
  | "purchase.paid"
  | "purchase.failed";

/**
 * Record one step of a purchase in the audit log: where it was paid, how much and with what card by
 * its last four digits, never a card number, security code or payment token. `source` says whether
 * the user approves it in chat (a checkout page) or in their wallet. Never throws.
 */
export function recordPurchaseEvent(event: {
  action: PurchaseAuditAction;
  actor: AuditEventInput["actor"];
  spaceId: string;
  runId?: string | null;
  threadId?: string | null;
  source: "page" | "wallet";
  /** The approval card's effect for a page purchase, the purchase for a wallet's. */
  target: { type: "external_effect" | "purchase"; id: string };
  merchant: string;
  amount?: string;
  last4?: string;
}): Promise<boolean> {
  const last4 = event.last4?.match(/^\d{4}$/) ? event.last4 : undefined;
  return tryRecordAuditEvent({
    action: event.action,
    actor: event.actor,
    spaceId: event.spaceId,
    target: { type: event.target.type, id: event.target.id, label: event.merchant },
    outcome: event.action === "purchase.failed" ? "failure" : "success",
    runId: event.runId,
    threadId: event.threadId,
    metadata: {
      source: event.source,
      merchant: event.merchant,
      amount: event.amount,
      last4,
    },
  });
}
