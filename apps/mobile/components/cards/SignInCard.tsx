import { useLingui } from "@lingui/react/macro";
import type { SignInBlock } from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Linking, StyleSheet, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { native, useMobileTokens } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { useThreadReadOnly } from "../../lib/thread/thread-read-only";
import { NativeActionButton } from "../native/native-action-button";

const styles = StyleSheet.create({
  card: { maxWidth: 576, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 8 },
});

function siteHost(site: string): string {
  return URL.canParse(site) ? new URL(site).host : site;
}

/**
 * A bot asking to sign in to a site with a login from the person's password manager. The review
 * opens the password manager's app through the system, with the link exactly as it came.
 */
export function SignInCard({ block }: { block: SignInBlock }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const label = block.label;
  const review = useSave({
    save: (requestId: string, send) => send("signInSource/review", { requestId }),
    onSaved: ({ approvalLink }) => Linking.openURL(approvalLink),
  });
  const connect = useSave({
    save: (_: void, send) => send("signInSource/connect", undefined),
    onSaved: ({ authorizeUrl }) => Linking.openURL(authorizeUrl),
  });
  const outcome =
    block.status === "approved"
      ? t`Approved`
      : block.status === "denied"
        ? t`Declined`
        : block.status === "expired"
          ? t`Expired`
          : block.status === "failed"
            ? t`Couldn't finish`
            : null;
  const error = review.error
    ? errorText(review.error, t`Couldn't open the request`)
    : connect.error
      ? errorText(connect.error, t`Couldn't connect ${label}`)
      : null;
  return (
    <View testID="sign-in-card" style={[styles.card, { backgroundColor: native.fill }]}>
      <Text style={[typeScale.body, { color: tokens.foreground, fontWeight: fontWeight.medium }]}>
        {siteHost(block.site)}
      </Text>
      <Text
        style={[
          typeScale.secondary,
          { color: block.status === "approved" ? tokens.success : tokens.mutedForeground },
        ]}
      >
        {outcome ??
          (block.status === "needs_connection"
            ? t`No password manager connected`
            : t`Sign in with ${label}`)}
      </Text>
      {outcome || readOnly ? null : block.status === "needs_connection" ? (
        <NativeActionButton
          label={t`Connect ${label}`}
          busy={connect.pending}
          disabled={connect.pending}
          onPress={() => connect.run()}
        />
      ) : block.requestId ? (
        <NativeActionButton
          label={t`Review in ${label}`}
          busy={review.pending}
          disabled={review.pending}
          onPress={() => block.requestId && review.run(block.requestId)}
        />
      ) : null}
      {error ? (
        <Text style={[typeScale.caption, { color: tokens.destructive }]}>{error}</Text>
      ) : null}
    </View>
  );
}
