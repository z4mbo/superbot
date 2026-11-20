import { Trans, useLingui } from "@lingui/react/macro";
import { OptionSelect, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { useRegistryInstallations } from "./community-store";
import { grantedParts } from "./registry";

/** Which agent may use each skill of the community plugins installed here, one agent at a time. */
export function CommunitySkillGrants({ activeBotId }: { activeBotId?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const installations = useRegistryInstallations();
  const bots = useQuery(queries.bots.list.queryOptions()).data ?? [];
  const [chosenBot, setChosenBot] = useState<string | null>(null);
  const botId =
    [chosenBot, activeBotId].find((id) => id && bots.some((bot) => bot.id === id)) ?? bots[0]?.id;
  const grants = useSave({
    save: (input: { installationId: string; botId: string; partIds: string[] }, rpc) =>
      rpc.pluginRegistry.setGrants(input),
    stale: [queries.pluginRegistry.installations.key()],
  });
  const skills = (installations.data ?? []).flatMap((installation) =>
    installation.plugin.manifest.parts
      .filter((part) => part.kind === "skill")
      .map((part) => ({ installation, part })),
  );
  if (!skills.length || !botId) return null;

  return (
    <section data-testid="community-skill-grants">
      <div className="mb-2 flex items-center justify-between gap-3 px-2.5">
        <h3 className="text-body font-medium text-muted-foreground">
          <Trans>Community skills</Trans>
        </h3>
        <div className="flex items-center gap-2">
          <span
            id="community-skill-bot-label"
            className="text-body-sm whitespace-nowrap text-muted-foreground"
          >
            <Trans>Allowed for</Trans>
          </span>
          <OptionSelect
            aria-labelledby="community-skill-bot-label"
            size="sm"
            value={botId}
            disabled={grants.pending}
            options={bots.map((bot) => ({ value: bot.id, label: bot.name }))}
            onValueChange={setChosenBot}
          />
        </div>
      </div>
      {grants.error ? (
        <p role="alert" className="mb-2 px-2.5 text-body text-destructive">
          {errorText(grants.error, t`Could not change bot access`)}
        </p>
      ) : null}
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {skills.map(({ installation, part }) => {
          const granted = grantedParts(installation, botId);
          const on = granted.includes(part.id);
          const bot = bots.find((row) => row.id === botId)?.name ?? "";
          return (
            <li
              key={`${installation.id}:${part.id}`}
              data-testid="community-skill-grant"
              className="flex items-center gap-3 px-4 py-3"
            >
              <FileText size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-lg font-medium text-foreground">
                  {part.id}
                </span>
                <span className="block truncate text-body-sm text-muted-foreground">
                  {installation.plugin.manifest.name}
                </span>
              </span>
              <Switch
                aria-label={t`Allow ${part.id} for ${bot}`}
                checked={on}
                disabled={grants.pending}
                onCheckedChange={(next) =>
                  grants.run({
                    installationId: installation.id,
                    botId,
                    partIds: next ? [...granted, part.id] : granted.filter((id) => id !== part.id),
                  })
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
