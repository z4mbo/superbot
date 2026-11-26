import { tryRecordAuditEvent } from "@rakazo/db";

/** The audit actions of sign-in sources; never a username, password, code, token or link. */
export type SignInAuditAction =
  | "sign_in_source.connected"
  | "sign_in_source.disconnected"
  | "sign_in.requested"
  | "sign_in.approved"
  | "sign_in.denied"
  | "sign_in.expired"
  | "sign_in.filled"
  | "sign_in.fill_failed";

/**
 * Record one step of a sign-in source's life: the person connecting or disconnecting it, and a
 * bot's sign-in request from asking to filling. Never throws, as the audit log never does.
 */
export function recordSignInEvent(event: {
  action: SignInAuditAction;
  actor: { type: "user"; id: string } | { type: "bot"; id: string; label: string };
  userId: string;
  spaceId?: string;
  provider: string;
  site?: string;
  requestId?: string;
  runId?: string;
  threadId?: string;
  outcome?: "success" | "failure" | "denied";
}): Promise<boolean> {
  return tryRecordAuditEvent({
    action: event.action,
    actor: event.actor,
    spaceId: event.spaceId,
    userId: event.userId,
    target: event.requestId
      ? { type: "sign_in_request", id: event.requestId, label: event.site ?? null }
      : { type: "sign_in_source", id: event.userId, label: null },
    outcome: event.outcome ?? "success",
    runId: event.runId,
    threadId: event.threadId,
    metadata: { provider: event.provider, site: event.site },
  });
}
