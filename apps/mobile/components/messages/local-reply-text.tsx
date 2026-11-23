import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Text } from "react-native";
import type { mobileTokens } from "../../lib/appearance/appearance";

export function LocalReplyText({
  name,
  text,
  tokens,
}: {
  name?: string;
  text: string;
  tokens: ReturnType<typeof mobileTokens>;
}) {
  const { t } = useLingui();
  return (
    <>
      <Text style={{ color: tokens.mutedForeground, ...typeScale.footnote, marginBottom: 4 }}>
        {name ? t`Local CLI used by ${name}` : t`Local CLI`}
      </Text>
      <Text style={{ color: tokens.foreground, ...typeScale.body }}>{text}</Text>
    </>
  );
}
