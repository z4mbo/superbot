import { useLingui } from "@lingui/react/macro";
import type { MessageBlock, PurchaseCardState } from "@rakazo/contracts";
import type { PaymentAskBlock } from "@rakazo/core";
import { purchaseCardView } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { CreditCard } from "lucide-react";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";
import { AskReceiptView } from "./AskCard";

type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

function openWallet(url: string) {
  // Electron hands a new window to the system browser.
  window.open(url, "_blank", "noopener,noreferrer");
}

function StateBadge({ state }: { state: Exclude<PurchaseCardState, "pending"> }) {
  const { t } = useLingui();
  const label = {
    approved: t`Approved`,
    paid: t`Paid`,
    canceled: t`Cancelled`,
    failed: t`Failed`,
    expired: t`Expired`,
  }[state];
  return (
    <Badge
      data-testid="purchase-state"
      variant={state === "failed" ? "destructive" : "secondary"}
      className={state === "paid" ? "text-success" : undefined}
    >
      {label}
    </Badge>
  );
}

export type PurchaseCardProps =
  | {
      /** A purchase on a checkout page: the user's Pay is the approval. */
      block: PaymentAskBlock;
      canAnswer: boolean;
      onAnswer: (answer: "allow" | "deny") => Promise<void>;
    }
  | {
      /** A purchase the user's wallet approves; the chat can cancel it. */
      block: PurchaseBlock;
      canAnswer?: undefined;
      onAnswer?: undefined;
    };

/** A purchase's order card while it waits on the user, then how it ended. */
export function PurchaseCard(props: PurchaseCardProps) {
  const { t } = useLingui();
  const { block } = props;
  const view = purchaseCardView(block);
  const answer = useSave({
    save: async (choice: "allow" | "deny", rpc) => {
      if (props.block.kind === "purchase")
        await rpc.paymentWallet.cancelPurchase({ id: props.block.purchaseId });
      else await props.onAnswer?.(choice);
    },
  });
  // A sent answer shows at once; the stored card says the same once the chat reads it again.
  const sent = answer.input !== undefined && !answer.pending && !answer.error;
  const state: PurchaseCardState =
    view.state === "pending" && sent
      ? answer.input === "allow"
        ? "approved"
        : "canceled"
      : view.state;
  const pending = state === "pending";
  const actionable = pending && (block.kind === "purchase" || props.canAnswer);
  const merchant = view.merchant || t`This page`;
  return (
    <BuiCard data-testid="purchase-card" className="w-full min-w-0 max-w-xl px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-body-lg font-medium leading-[1.5] text-foreground">
          {merchant}
        </p>
        {state === "pending" ? null : <StateBadge state={state} />}
      </div>
      {view.receipt ? (
        <AskReceiptView receipt={view.receipt} />
      ) : view.amount ? (
        <p className="mt-3 flex items-baseline justify-between gap-4 text-body-lg font-medium leading-[1.5]">
          <span>{t`Total`}</span>
          <span className="tabular-nums">{view.amount}</span>
        </p>
      ) : null}
      {view.method || view.wallet ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-body-sm text-muted-foreground">
          <CreditCard aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 break-words">{view.method ?? view.wallet?.name}</span>
        </p>
      ) : null}
      {actionable ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {block.kind === "purchase" ? (
            view.wallet?.approveUrl ? (
              <Button
                disabled={answer.pending}
                onClick={() => openWallet(view.wallet!.approveUrl!)}
              >
                {t`Approve in ${view.wallet.name}`}
              </Button>
            ) : null
          ) : (
            <Button disabled={answer.pending} onClick={() => answer.run("allow")}>
              {answer.pending && answer.input === "allow" ? t`Paying…` : t`Pay`}
            </Button>
          )}
          <Button variant="outline" disabled={answer.pending} onClick={() => answer.run("deny")}>
            {t`Cancel`}
          </Button>
        </div>
      ) : pending && block.kind === "ask" ? (
        <p className="mt-3.5 text-body font-medium text-muted-foreground">{t`No longer active`}</p>
      ) : null}
      {answer.error ? (
        <p className="mt-3 text-body-sm text-destructive">
          {errorText(answer.error, t`Could not submit this answer`)}
        </p>
      ) : null}
    </BuiCard>
  );
}
