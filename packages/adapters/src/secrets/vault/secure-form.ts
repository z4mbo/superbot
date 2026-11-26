import type { BotSecretAuthType } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { BotSecretScope } from "./vault-access.js";
import { vaultFields } from "./vault-access.js";
import { recordVaultEvent, VAULT_AUDIT_ACTIONS } from "./vault-activity.js";

/**
 * A Secure form a person sent in chat: a request_secret card for a vault item. Its values went
 * straight to the vault (`saved`) or to this run only, for one fill the person approved, and never
 * to the transcript or the model. Only what became of it is recorded, never a value.
 */
export type SecureFormOutcome = {
  scope: BotSecretScope;
  runId: string;
  threadId: string;
  answeredByUserId: string;
  /** The name the bot asked for it under. */
  name: string;
  kind: BotSecretAuthType;
  saved: boolean;
};

/** Record a sent Secure form in the audit log, on the saved item when it was saved. */
export async function recordSecureFormOutcome(
  prisma: Pick<PrismaClient, "vaultCredential" | "spaceSettingOverride">,
  form: SecureFormOutcome,
): Promise<void> {
  const event = {
    actor: { type: "user" as const, id: form.answeredByUserId },
    spaceId: form.scope.spaceId,
    userId: form.scope.userId,
    runId: form.runId,
    threadId: form.threadId,
  };
  if (!form.saved) {
    await recordVaultEvent({
      ...event,
      action: VAULT_AUDIT_ACTIONS.fillApproved,
      unsaved: { name: form.name, kind: form.kind },
    });
    return;
  }
  const row = await prisma.vaultCredential
    .findFirst({
      where: { ...(await vaultFields(prisma, form.scope)), name: form.name },
      select: { id: true, name: true, spaceId: true },
    })
    .catch((error: unknown) => {
      // The form is saved; only its record is lost, and the log says which run's.
      getLogger().warn("secure form item could not be read for its audit event", {
        runId: form.runId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return null;
    });
  if (!row) return;
  await recordVaultEvent({
    ...event,
    action: VAULT_AUDIT_ACTIONS.formSaved,
    item: { ...row, kind: form.kind },
  });
}
