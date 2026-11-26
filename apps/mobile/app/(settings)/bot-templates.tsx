import { useLingui } from "@lingui/react/macro";
import type { BotTemplateListing } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotTemplateIcon } from "../../components/bots/bot-template-icon";
import { NativeActionButton } from "../../components/native/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { botTemplateCopy } from "../../lib/bots/bot-template-copy";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery } from "../../lib/query/query";

/** Ready-made bots, Superbot's and approved ones people shared; each page shows what it sends. */
export default function BotTemplatesScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const templates = useQuery(rpcQuery("bots/templates"), queryClient);
  const community = useQuery(rpcQuery("communityTemplates/list"), queryClient);
  const { refetch } = templates;
  const { refetch: refetchCommunity } = community;
  const open = (id: string) => router.push({ pathname: "/bot-template", params: { id } });
  const shared = community.data ?? [];

  // A bot made from a template, or deleted since, changes what each one opens.
  useFocusEffect(
    useCallback(() => {
      void refetch();
      void refetchCommunity();
    }, [refetch, refetchCommunity]),
  );

  const rows = (list: readonly BotTemplateListing[]) =>
    list.map((template) => {
      const { name, summary } = botTemplateCopy(template);
      return (
        <SettingsRow
          key={template.id}
          testID="bot-template-row"
          accessibilityRole="button"
          title={name}
          detail={summary}
          leading={<BotTemplateIcon id={template.id} />}
          chevron="right"
          onPress={() => open(template.id)}
        />
      );
    });

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {templates.error && !templates.data ? (
          <View style={styles.list}>
            <Text style={styles.error}>
              {errorText(templates.error, t`Could not load templates`)}
            </Text>
            <NativeActionButton
              fill={false}
              label={t`Retry`}
              onPress={() => void refetch()}
              prominence="secondary"
            />
          </View>
        ) : null}
        {templates.isPending ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {templates.data?.length ? (
          <SettingsGroup label={shared.length ? t`From Superbot` : undefined}>
            {rows(templates.data)}
          </SettingsGroup>
        ) : null}
        {templates.data && shared.length ? (
          <SettingsGroup label={t`Community`}>{rows(shared)}</SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    list: { gap: 8 },
    error: { color: native.secondaryLabel, fontSize: 14 },
  });
}
