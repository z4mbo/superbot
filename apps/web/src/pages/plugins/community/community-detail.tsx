import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, OptionSelect, Spinner, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Copy, FileText, NotebookPen, Plug } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { PluginLogo } from "../../../components/integrations/plugin-marketplace";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import type { RegistryInstallation, RegistryPart, RegistryVersion } from "./registry";
import { appParts, grantedBots, grantedParts, REGISTRY_PAGE_SIZE, readAllPages } from "./registry";

type ConfirmedChange =
  | { kind: "uninstall"; installationId: string }
  | { kind: "switch"; installationId: string; expectedVersionId: string; versionId: string };
type Change = { kind: "install"; versionId: string } | ConfirmedChange;

/** An approved community plugin: its versions, parts, install and which bots may use each part. */
export function CommunityDetail({
  slug,
  preferredVersion,
  installation,
  bots,
  activeBotId,
  onBack,
  onOpenApp,
  onUseTemplate,
}: {
  slug: string;
  preferredVersion?: number;
  installation: RegistryInstallation | undefined;
  bots: readonly Bot[];
  activeBotId?: string;
  onBack: () => void;
  onOpenApp: (partId: string) => void;
  onUseTemplate: (version: RegistryVersion) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const versions = useQuery({
    queryKey: registry.discover.queryKey({ input: { slug, limit: REGISTRY_PAGE_SIZE } }),
    queryFn: ({ signal }) =>
      readAllPages((after) =>
        registry.discover.call({ slug, limit: REGISTRY_PAGE_SIZE, after }, { signal }),
      ),
  });
  const installed = installation?.plugin;
  const available = [...(versions.data ?? [])];
  if (installed && !available.some((row) => row.id === installed.id)) available.push(installed);
  available.sort((a, b) => b.version - a.version);
  const latest = available[0];
  const [chosenVersion, setChosenVersion] = useState<number | null>(null);
  const shown: RegistryVersion | undefined =
    available.find((row) => row.version === chosenVersion) ??
    installed ??
    available.find((row) => row.version === preferredVersion) ??
    latest;
  const [confirming, setConfirming] = useState<ConfirmedChange | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chosenBot, setChosenBot] = useState<string | null>(null);
  const botId =
    [chosenBot, activeBotId].find((id) => id && bots.some((bot) => bot.id === id)) ?? bots[0]?.id;

  const stale = [registry.installations.key(), registry.appRecords.key()];
  const change = useSave({
    save: async (input: Change, rpc) => {
      if (input.kind === "install")
        return rpc.pluginRegistry.install({ versionId: input.versionId });
      if (input.kind === "switch") {
        const { installationId, expectedVersionId, versionId } = input;
        return rpc.pluginRegistry.switchVersion({ installationId, expectedVersionId, versionId });
      }
      return rpc.pluginRegistry.uninstall({ installationId: input.installationId });
    },
    stale,
    onSaved: () => setConfirming(null),
  });
  const grants = useSave({
    save: (input: { botId: string; partIds: string[] }, rpc) =>
      rpc.pluginRegistry.setGrants({ installationId: installation!.id, ...input }),
    stale,
  });
  const busy = change.pending || grants.pending;

  if (versions.isPending && !installed)
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  if (!shown)
    return (
      <div className="space-y-4">
        <BackButton onBack={onBack} />
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {versions.isError
            ? errorText(versions.error, t`Could not load this app`)
            : t`This app is no longer available.`}
          {versions.isError ? (
            <Button variant="outline" size="sm" onClick={() => void versions.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
      </div>
    );

  const viewingInstalled = installed?.id === shown.id;
  const apps = appParts(shown.manifest);
  const botCount = installation ? grantedBots(installation).length : 0;
  const granted = installation && botId ? grantedParts(installation, botId) : [];

  function toggle(part: RegistryPart, on: boolean) {
    if (!botId) return;
    const next = on ? [...granted, part.id] : granted.filter((id) => id !== part.id);
    grants.run({ botId, partIds: next });
  }

  function action() {
    if (confirming && installation) {
      const uninstalling = confirming.kind === "uninstall";
      return (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => change.run(confirming)}>
            {change.pending ? (
              uninstalling ? (
                <Trans>Uninstalling…</Trans>
              ) : (
                <Trans>Switching…</Trans>
              )
            ) : botCount ? (
              <Plural
                value={botCount}
                one="Remove access from # bot"
                other="Remove access from # bots"
              />
            ) : uninstalling ? (
              <Trans>Confirm uninstall</Trans>
            ) : (
              <Trans>Confirm switch</Trans>
            )}
          </Button>
        </>
      );
    }
    if (installation)
      return viewingInstalled ? (
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirming({ kind: "uninstall", installationId: installation.id })}
          >
            <Trans>Uninstall</Trans>
          </Button>
          {apps.length === 1 ? (
            <Button
              size="lg"
              className="px-5"
              disabled={busy}
              onClick={() => onOpenApp(apps[0]!.id)}
            >
              <Trans>Open</Trans>
            </Button>
          ) : null}
        </>
      ) : (
        <Button
          size="lg"
          className="px-5"
          disabled={busy}
          onClick={() =>
            setConfirming({
              kind: "switch",
              installationId: installation.id,
              expectedVersionId: installation.plugin.id,
              versionId: shown!.id,
            })
          }
        >
          <Trans>Switch to version {shown!.version}</Trans>
        </Button>
      );
    return (
      <Button
        size="lg"
        className="px-5"
        disabled={busy}
        onClick={() => change.run({ kind: "install", versionId: shown!.id })}
      >
        {change.pending ? <Trans>Installing…</Trans> : <Trans>Install</Trans>}
      </Button>
    );
  }

  const failure = change.error
    ? errorText(change.error, t`Could not change this app`)
    : grants.error
      ? errorText(grants.error, t`Could not change bot access`)
      : null;
  const appWarning =
    confirming && installation && appParts(installation.plugin.manifest).length
      ? confirming.kind === "uninstall"
        ? t`Uninstalling permanently deletes your entries in this app.`
        : t`Each version keeps its own entries. Switching back shows them again.`
      : null;
  const note = !installation ? (
    <Trans>After installing, choose which bots can use each part.</Trans>
  ) : !viewingInstalled ? null : !bots.length ? (
    <Trans>Create a bot to give it access.</Trans>
  ) : shown.manifest.parts.some((part) => part.kind === "mcp") ? (
    <Trans>Bots ask before calling an app's tools.</Trans>
  ) : null;

  return (
    <div data-testid="community-plugin-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <BackButton onBack={onBack} disabled={busy} className="mt-3.5" />
        <PluginLogo name={shown.manifest.name} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">
            {shown.manifest.name}
          </h2>
          <Facts className="text-body">
            <span className="truncate font-mono">{shown.slug}</span>
            {installed ? (
              <span>
                <Trans>Version {installed.version} installed</Trans>
              </span>
            ) : (
              <span>
                <Trans>Version {shown.version}</Trans>
              </span>
            )}
          </Facts>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 pt-2">{action()}</div>
      </div>

      <p className="text-body-lg leading-6 whitespace-pre-wrap text-muted-foreground" dir="auto">
        {shown.manifest.description}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {available.length > 1 ? (
          <div className="flex items-center gap-3">
            <span id="community-version-label" className="text-body text-muted-foreground">
              <Trans>Version</Trans>
            </span>
            <OptionSelect
              aria-labelledby="community-version-label"
              data-testid="community-version"
              className="w-auto"
              value={String(shown.version)}
              disabled={busy}
              options={available.map((row) => ({
                value: String(row.version),
                label:
                  row.id === installed?.id
                    ? t`Version ${row.version} (installed)`
                    : row.id === latest?.id
                      ? t`Version ${row.version} (latest)`
                      : t`Version ${row.version}`,
              }))}
              onValueChange={(value) => {
                setConfirming(null);
                setChosenVersion(Number(value));
              }}
            />
          </div>
        ) : null}
        <Button
          type="button"
          variant="text"
          size="sm"
          className="ms-auto"
          disabled={busy}
          onClick={() => onUseTemplate(shown!)}
        >
          <Copy />
          <Trans>Use as template</Trans>
        </Button>
      </div>

      {appWarning ? (
        <p role="alert" className="text-body text-foreground">
          {appWarning}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-body text-destructive">
          {failure}
        </p>
      ) : null}

      <section>
        <div className="mb-2 flex min-h-8 items-center justify-between gap-3 px-1">
          <h3 className="flex gap-2 text-body font-medium text-foreground">
            <Trans>Parts</Trans>
            <span className="text-muted-foreground">{shown.manifest.parts.length}</span>
          </h3>
          {viewingInstalled && bots.length && botId ? (
            <div className="flex items-center gap-2">
              <span
                id="community-bot-label"
                className="text-body-sm whitespace-nowrap text-muted-foreground"
              >
                <Trans>Allowed for</Trans>
              </span>
              <OptionSelect
                aria-labelledby="community-bot-label"
                data-testid="community-grant-bot"
                size="sm"
                value={botId}
                disabled={busy}
                options={bots.map((bot) => ({ value: bot.id, label: bot.name }))}
                onValueChange={setChosenBot}
              />
            </div>
          ) : null}
        </div>
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {shown.manifest.parts.map((part) => (
            <PartRow
              key={part.id}
              part={part}
              expanded={expanded === part.id}
              onExpand={() => setExpanded((open) => (open === part.id ? null : part.id))}
              onOpen={
                viewingInstalled && part.kind === "app" ? () => onOpenApp(part.id) : undefined
              }
              grant={
                viewingInstalled && botId
                  ? {
                      on: granted.includes(part.id),
                      disabled: busy,
                      onChange: (on) => toggle(part, on),
                    }
                  : undefined
              }
            />
          ))}
        </ul>
        {note ? <p className="mt-2 px-1 text-body-sm text-muted-foreground">{note}</p> : null}
      </section>
    </div>
  );
}

/** Short secondary facts about a plugin, each its own muted element. */
export function Facts({
  children,
  className = "text-body-sm",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-wrap gap-x-3 text-muted-foreground ${className}`}>
      {children}
    </div>
  );
}

export function BackButton({
  onBack,
  disabled,
  className = "",
}: {
  onBack: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={`-ms-2 text-muted-foreground ${className}`}
      aria-label={t`Back`}
      disabled={disabled}
      onClick={onBack}
    >
      <ChevronLeft />
    </Button>
  );
}

/** A manifest part: a skill opens its instructions, and an endpoint shows where its tools run. */
export function PartRow({
  part,
  expanded,
  onExpand,
  onOpen,
  grant,
}: {
  part: RegistryPart;
  expanded: boolean;
  onExpand: () => void;
  /** Opens an installed app part. */
  onOpen?: () => void;
  grant?: { on: boolean; disabled: boolean; onChange: (on: boolean) => void };
}) {
  const { t } = useLingui();
  const Icon = part.kind === "skill" ? FileText : part.kind === "app" ? NotebookPen : Plug;
  const detail =
    part.kind === "skill"
      ? t`Skill`
      : part.kind === "app"
        ? part.fields.map((field) => field.label).join(", ")
        : t`Tools at ${part.endpoint}`;
  const body = (
    <>
      <Icon size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-lg font-medium text-foreground">{part.id}</span>
        <span className="block truncate text-body-sm text-muted-foreground">
          {part.kind === "app" ? <Trans>App: {detail}</Trans> : detail}
        </span>
      </span>
    </>
  );
  return (
    <li data-testid="community-part" aria-label={part.id}>
      <div className="flex items-center gap-3 px-4 py-3">
        {part.kind === "skill" ? (
          <button
            type="button"
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={onExpand}
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
        )}
        {onOpen ? (
          <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
            <Trans>Open</Trans>
          </Button>
        ) : null}
        {grant ? (
          <Switch
            aria-label={t`Allow ${part.id}`}
            checked={grant.on}
            disabled={grant.disabled}
            onCheckedChange={grant.onChange}
          />
        ) : null}
      </div>
      {expanded && part.kind === "skill" ? (
        <pre
          className="max-h-80 overflow-auto border-t border-border/60 px-4 py-3 font-mono text-body-sm whitespace-pre-wrap text-foreground"
          dir="auto"
        >
          {part.instructions}
        </pre>
      ) : null}
    </li>
  );
}
