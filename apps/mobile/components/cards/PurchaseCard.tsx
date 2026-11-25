import { useLingui } from "@lingui/react/macro";
import type { MessageBlock, PurchaseCardState } from "@rakazo/contracts";
import type { PaymentAskBlock } from "@rakazo/core";
import { purchaseCardView } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { TextProps } from "react-native";
import { Alert, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useMobileTokens } from "../../lib/native/native";
import { openExternalUrl } from "../../lib/platform/open-url";
import { useSave } from "../../lib/query/query";
import { NativeActionButton } from "../native/native-action-button";
import { AskReceiptView } from "./ask-receipt";

type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

/**
 * A purchase's order card while it waits on the user, then how it ended: Pay and Cancel for a
 * checkout page, or Cancel and the wallet's own approval for a wallet purchase.
 */
export function PurchaseCard({
  block,
  canAnswer,
  onAnswer,
  actionProps,
}: {
  block: PaymentAskBlock | PurchaseBlock;
  canAnswer?: boolean;
  onAnswer: (answer: "allow" | "deny") => Promise<void>;
  actionProps: Pick<TextProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const view = purchaseCardView(block);
  const answer = useSave({
    save: async (choice: "allow" | "deny", send) => {
      if (block.kind === "purchase")
        await send("paymentWallet/cancelPurchase", { id: block.purchaseId });
      else await onAnswer(choice);
    },
    onFailed: (reason) =>
      Alert.alert(t`Could not submit answer`, errorText(reason, t`Please try again.`)),
  });
  // A sent answer shows at once; the stored card says the same once the chat reads it again.
  const sent = answer.input !== undefined && !answer.pending && !answer.error;
  const state: PurchaseCardState =
    view.state === "pending" && sent
      ? answer.input === "allow"
        ? "approved"
        : "canceled"
      : view.state;
  const labels: Record<Exclude<PurchaseCardState, "pending">, string> = {
    approved: t`Approved`,
    paid: t`Paid`,
    canceled: t`Cancelled`,
    failed: t`Failed`,
    expired: t`Expired`,
  };
  const actionable = state === "pending" && (block.kind === "purchase" || canAnswer);
  const muted = { color: tokens.mutedForeground, ...typeScale.secondary };
  return (
    <View
      testID="purchase-card"
      style={{
        maxWidth: 576,
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
        <Text
          {...actionProps}
          style={{ flexShrink: 1, color: tokens.foreground, ...typeScale.cardTitle }}
        >
          {view.merchant || t`This page`}
        </Text>
        {state === "pending" ? null : (
          <Text
            style={{
              marginStart: "auto",
              ...typeScale.secondary,
              fontWeight: fontWeight.medium,
              color:
                state === "paid"
                  ? tokens.success
                  : state === "failed"
                    ? tokens.destructive
                    : tokens.mutedForeground,
            }}
          >
            {labels[state]}
          </Text>
        )}
      </View>
      {view.receipt ? (
        <AskReceiptView receipt={view.receipt} />
      ) : view.amount ? (
        <View style={{ flexDirection: "row", marginTop: 10, gap: 16 }}>
          <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>{t`Total`}</Text>
          <Text
            style={{
              marginStart: "auto",
              color: tokens.foreground,
              ...typeScale.secondary,
              fontWeight: fontWeight.medium,
              fontVariant: ["tabular-nums"],
            }}
          >
            {view.amount}
          </Text>
        </View>
      ) : null}
      {view.method || view.wallet ? (
        <Text style={[muted, { marginTop: 8 }]}>{view.method ?? view.wallet?.name}</Text>
      ) : null}
      {actionable ? (
        <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {block.kind === "purchase" ? (
            view.wallet?.approveUrl ? (
              <NativeActionButton
                label={t`Approve in ${view.wallet.name}`}
                fill={false}
                disabled={answer.pending}
                onPress={() => void openExternalUrl(view.wallet!.approveUrl!)}
              />
            ) : null
          ) : (
            <NativeActionButton
              label={t`Pay`}
              fill={false}
              disabled={answer.pending}
              busy={answer.pending && answer.input === "allow"}
              onPress={() => answer.run("allow")}
            />
          )}
          <NativeActionButton
            label={t`Cancel`}
            prominence="secondary"
            fill={false}
            disabled={answer.pending}
            busy={answer.pending && answer.input === "deny"}
            onPress={() => answer.run("deny")}
          />
        </View>
      ) : state === "pending" ? (
        <Text style={[muted, { marginTop: 12 }]}>{t`No longer active`}</Text>
      ) : null}
    </View>
  );
}
