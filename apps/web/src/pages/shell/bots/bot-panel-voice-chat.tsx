import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { VOICE_LANGUAGE_TAGS } from "@rakazo/core";
import { OptionSelect, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { getActiveUiLocale } from "../../../lib/locale/i18n";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { PanelCardRow, PanelCardSection } from "./bot-panel-card";

/** A language tag's name in the app's language, or the tag when the browser cannot name it. */
function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The bot's voice and the language its voice chats and dictation use. Shown only once the
 * account has voice connected: before that there is nothing to choose. The voice is the panel's
 * own, which its settings show too, so both rows edit one value through one save.
 */
export function BotPanelVoiceChat({
  bot,
  voiceId,
  onVoiceIdChange,
  onSaved,
}: {
  bot: Bot;
  voiceId: string;
  onVoiceIdChange: (voiceId: string) => void;
  /** The saved bot, for the panel that holds the roster. */
  onSaved?: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const queries = useSpaceQueries();
  const status = useQuery(queries.voice.status.queryOptions()).data;
  const available = Boolean(status && (status.dictation || status.live));
  const voices = useQuery({
    ...queries.voice.voices.queryOptions({ input: {} }),
    enabled: available && Boolean(status?.ready),
  }).data;
  const save = useSave({
    save: (voiceLanguage: string | null, client) =>
      client.bots.update({ botId: bot.id, voiceLanguage }),
    stale: () => [queries.bots.list.key()],
    onSaved: (saved) => onSaved?.(saved),
    onFailed: (error) => toast.error(errorText(error, t`Could not save the voice chat settings`)),
  });
  if (!available) return null;
  const language = save.pending ? (save.input ?? "") : (bot.voiceLanguage ?? "");
  const locale = getActiveUiLocale();
  const languages: { value: string; label: string }[] = VOICE_LANGUAGE_TAGS.map((tag) => ({
    value: tag,
    label: languageName(tag, locale),
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
  // A language saved elsewhere but missing from the list still shows as chosen.
  if (language && !languages.some((option) => option.value === language))
    languages.push({ value: language, label: languageName(language, locale) });
  return (
    <PanelCardSection label={<Trans>Voice chat</Trans>} testId="bot-voice-chat">
      {voices?.length ? (
        <PanelCardRow>
          <label htmlFor={`${ids}-voice`}>
            <Trans>Voice</Trans>
          </label>
          <OptionSelect
            id={`${ids}-voice`}
            size="sm"
            className="w-fit max-w-2/3"
            value={voiceId}
            onValueChange={onVoiceIdChange}
            options={[
              { value: "", label: t`Account default` },
              ...voices.map((voice) => ({ value: voice.id, label: voice.label })),
            ]}
          />
        </PanelCardRow>
      ) : null}
      <PanelCardRow>
        <label htmlFor={`${ids}-voice-language`}>
          <Trans>Language</Trans>
        </label>
        <OptionSelect
          id={`${ids}-voice-language`}
          size="sm"
          className="w-fit max-w-2/3"
          value={language}
          disabled={save.pending}
          onValueChange={(next) => save.run(next || null)}
          options={[{ value: "", label: t`Auto-detect` }, ...languages]}
        />
      </PanelCardRow>
    </PanelCardSection>
  );
}
