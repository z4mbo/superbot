import { Trans, useLingui } from "@lingui/react/macro";
import { Button, SectionHeading, Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BookOpen, KeyRound, Lock, Plug, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { sidePanelHeaderStyle } from "../resizable-side-panel";

type ProfileTab = "general" | "knowledge";

/** The same pill tabs as the bot's panel. */
export const profileTabClass =
  "h-auto flex-none rounded-full px-2.5 py-1 text-body-sm font-normal text-muted-foreground hover:text-foreground data-active:bg-accent data-active:text-foreground data-active:shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-none dark:text-muted-foreground dark:data-active:border-transparent dark:data-active:bg-accent";

/**
 * A bot's profile, in place of the chat: a banner, its avatar and name, who can use it, then its
 * settings under General and Knowledge. Its connectors, vault logins and skills open the screens
 * that manage them.
 */
export function BotProfilePage({
  botId,
  avatar,
  nameField,
  labelField,
  email,
  shared,
  spaceName,
  access,
  actions,
  general,
  knowledge,
  onClose,
  onOpenConnections,
  onOpenVault,
  onOpenSkills,
}: {
  botId: string;
  avatar: ReactNode;
  nameField: ReactNode;
  labelField: ReactNode;
  email: ReactNode;
  /** Whether other people share the bot's Space; unknown while it loads. */
  shared?: boolean;
  spaceName?: string;
  /** The Private or Shared pill. */
  access?: ReactNode;
  /** The bot's other actions, such as export. */
  actions: ReactNode;
  general: ReactNode;
  knowledge: ReactNode;
  onClose?: () => void;
  onOpenConnections?: () => void;
  onOpenVault?: () => void;
  onOpenSkills?: () => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<ProfileTab>("general");
  return (
    <div data-testid="bot-profile-page" className="relative min-h-full pb-10">
      <div aria-hidden="true" className="app-drag h-[124px] bg-muted" />
      <div
        className="absolute end-3 top-3 flex items-center gap-2"
        style={sidePanelHeaderStyle}
        data-testid="bot-profile-actions"
      >
        {actions}
        {access}
        <Button
          variant="floating"
          size="icon-lg"
          className="app-no-drag text-muted-foreground"
          aria-label={t`Close profile`}
          onClick={onClose}
        >
          <X className="size-4.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="mx-auto w-full max-w-[888px] px-4">
        <div className="px-3">
          <div className="-mt-8 mb-3 w-fit rounded-full bg-background p-[3px]">{avatar}</div>
          <div data-testid="bot-manage-profile" className="flex flex-col items-start gap-0.5">
            {nameField}
            {labelField}
            {email}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-body text-muted-foreground">
            {shared ? (
              <Users className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Lock className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            )}
            {shared && spaceName ? (
              <Trans>Shared in {spaceName}</Trans>
            ) : (
              <Trans>Private to you</Trans>
            )}
          </p>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ProfileTab)}
          className="mt-6 gap-0"
        >
          <TabsList className="mb-8 gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="general" className={profileTabClass}>
              <Trans>General</Trans>
            </TabsTrigger>
            <TabsTrigger value="knowledge" className={profileTabClass}>
              <Trans>Knowledge</Trans>
            </TabsTrigger>
          </TabsList>
          {/* Both stay mounted so a draft in one survives a look at the other. */}
          <TabsContent value="general" keepMounted className="space-y-8">
            <BotConnectors botId={botId} onAdd={onOpenConnections} />
            <BotVault botId={botId} onAdd={onOpenVault} />
            {general}
          </TabsContent>
          <TabsContent value="knowledge" keepMounted className="space-y-8">
            <BotSkills onAdd={onOpenSkills} />
            {knowledge}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function BotConnectors({ botId, onAdd }: { botId: string; onAdd?: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const assignments = useQuery(queries.mcp.assignments.list.queryOptions({ input: { botId } }));
  const servers = useQuery(queries.mcp.servers.list.queryOptions());
  const names = new Map((servers.data ?? []).map((server) => [server.id, server.name]));
  const items = (assignments.data ?? []).flatMap((row) => {
    const name = names.get(row.serverId);
    return name ? [{ id: row.id, title: name }] : [];
  });
  return (
    <ProfileList
      testId="bot-profile-connectors"
      label={t`Bot's connectors`}
      icon={Plug}
      items={items}
      loaded={assignments.data !== undefined && servers.data !== undefined}
      emptyTitle={t`This Bot has no connectors yet`}
      emptyDetail={t`Connect an app as this Bot`}
      onAdd={onAdd}
    />
  );
}

function BotVault({ botId, onAdd }: { botId: string; onAdd?: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const secrets = useQuery(queries.botSecrets.list.queryOptions({ input: { botId } }));
  const items = (secrets.data ?? []).map((secret) => ({
    id: secret.name,
    title: secret.title || secret.name,
    detail: secret.origin,
  }));
  return (
    <ProfileList
      testId="bot-profile-vault"
      label={t`Bot's vault`}
      icon={KeyRound}
      items={items}
      loaded={secrets.data !== undefined}
      emptyTitle={t`This Bot has no vault logins yet`}
      emptyDetail={t`Save a username and password`}
      onAdd={onAdd}
    />
  );
}

function BotSkills({ onAdd }: { onAdd?: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Skills belong to the Space, so every bot in it uses the same ones.
  const skills = useQuery(queries.agentSkills.list.queryOptions());
  const items = (skills.data ?? []).map((skill) => ({
    id: skill.id,
    title: skill.name,
    detail: skill.description,
  }));
  return (
    <ProfileList
      testId="bot-profile-skills"
      label={t`Skills`}
      icon={BookOpen}
      items={items}
      loaded={skills.data !== undefined}
      emptyTitle={t`No skills yet`}
      emptyDetail={t`Skills teach this Bot how to handle repeated tasks`}
      onAdd={onAdd}
    />
  );
}

function ProfileList({
  testId,
  label,
  icon: Icon,
  items,
  loaded,
  emptyTitle,
  emptyDetail,
  onAdd,
}: {
  testId: string;
  label: string;
  icon: LucideIcon;
  items: { id: string; title: string; detail?: string }[];
  loaded: boolean;
  emptyTitle: string;
  emptyDetail: string;
  onAdd?: () => void;
}) {
  const add = onAdd ? (
    <Button variant="secondary" className="rounded-full px-3" onClick={onAdd}>
      <Trans>Add</Trans>
    </Button>
  ) : null;
  const rows = items.length
    ? items.map((item, index) => ({ ...item, action: index === 0 ? add : null }))
    : loaded
      ? [{ id: "empty", title: emptyTitle, detail: emptyDetail, action: add }]
      : [];
  return (
    <section data-testid={testId}>
      <SectionHeading variant="panel" className="mb-2 px-3">
        {label}
      </SectionHeading>
      {rows.length ? (
        <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card">
          {rows.map((row) => (
            <li key={row.id} className="flex min-h-14 items-center gap-2.5 px-3 py-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-hairline text-muted-foreground">
                <Icon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm text-foreground">{row.title}</span>
                {row.detail ? (
                  <span className="block truncate text-label text-muted-foreground">
                    {row.detail}
                  </span>
                ) : null}
              </span>
              {row.action}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
