import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  BotTemplateCategory,
  BotTemplateListing,
  CommunityTemplateListing,
  ConnectionCatalogItem,
} from "@rakazo/contracts";
import { BOT_TEMPLATE_CATEGORIES, isBotTemplateChanged } from "@rakazo/contracts";
import { botTemplateApps, formatCron, matchesBotTemplateQuery } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Bot as BotIcon,
  Briefcase,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Code,
  GitPullRequest,
  Handshake,
  House,
  Inbox,
  ListTodo,
  Mail,
  Megaphone,
  Milestone,
  Palette,
  Plane,
  Salad,
  ScrollText,
  Search,
  Shield,
  ShoppingBag,
  Sun,
  Telescope,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorDetails } from "../../lib/query/user-error";
import { cronLabels } from "../../lib/routines/cron";
import { ErrorNotice } from "../ErrorNotice";
import { PluginLogo, ROW_HOVER } from "../integrations/plugin-marketplace";
import { useBotTemplateCategoryLabel, useBotTemplateCopy } from "./bot-template-copy";
import { MySharedTemplates, useCommunityByline } from "./community-templates";

const NO_TEMPLATES: BotTemplateListing[] = [];
const NO_COMMUNITY: CommunityTemplateListing[] = [];
const PAGE_SIZE = 24;
const CHIP_COUNT = 6;

const ICONS: Record<string, LucideIcon> = {
  "morning-briefing": Sun,
  "inbox-triage": Inbox,
  "pr-reviewer": GitPullRequest,
  "topic-watch": Telescope,
};

const CATEGORY_ICONS: Record<BotTemplateCategory, LucideIcon> = {
  assistant: ListTodo,
  email: Mail,
  meetings: Users,
  research: Search,
  engineering: Code,
  qa: BadgeCheck,
  product: Milestone,
  design: Palette,
  sales: Handshake,
  marketing: Megaphone,
  recruiting: UserPlus,
  operations: Building2,
  finance: Wallet,
  career: Briefcase,
  travel: Plane,
  shopping: ShoppingBag,
  health: Salad,
  home: House,
  privacy: Shield,
};

function TemplateIcon({
  template,
  large = false,
}: {
  template: Pick<BotTemplateListing, "id" | "category">;
  large?: boolean;
}) {
  const Icon = ICONS[template.id] ?? CATEGORY_ICONS[template.category];
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center border border-border/60 bg-muted text-foreground ${
        large ? "h-14 w-14 rounded-2xl" : "h-10 w-10 rounded-xl"
      }`}
    >
      <Icon size={large ? 24 : 18} />
    </span>
  );
}

function Sample({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body">
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/**
 * Ready-made bots, searchable and filtered by category. Creating one opens it; its routines stay
 * paused until the user turns them on.
 */
export function BotTemplatesPanel({ onOpenBot }: { onOpenBot: (bot: Bot) => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const copy = useBotTemplateCopy();
  const categoryLabel = useBotTemplateCategoryLabel();
  const sharedBy = useCommunityByline();
  // Read afresh each time it opens: a template's bot may have been made or deleted since.
  const templates = useQuery({ ...queries.bots.templates.queryOptions(), staleTime: 0 });
  // Shared by people on this server and approved by its admins; listed apart from Superbot's.
  const community = useQuery({
    ...queries.communityTemplates.list.queryOptions(),
    staleTime: 0,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<BotTemplateCategory | null>(null);
  const all = templates.data ?? NO_TEMPLATES;
  const shared = community.data ?? NO_COMMUNITY;
  const open =
    all.find((template) => template.id === openId) ??
    shared.find((template) => template.id === openId);
  const categories = BOT_TEMPLATE_CATEGORIES.filter((name) =>
    [...all, ...shared].some((template) => template.category === name),
  );
  const matches = <T extends BotTemplateListing>(list: readonly T[]) =>
    list.filter((template) => {
      if (category && template.category !== category) return false;
      const shown = copy(template);
      return matchesBotTemplateQuery(template, query, [
        shown.name,
        shown.summary,
        categoryLabel(template.category),
      ]);
    });

  function content() {
    if (templates.error)
      return (
        <ErrorNotice error={errorDetails(templates.error, t`Could not load templates`)}>
          <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </ErrorNotice>
      );
    if (!templates.data)
      return (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      );
    if (open)
      return (
        <TemplateDetail
          template={open}
          onBack={() => setOpenId(null)}
          onOpenBot={onOpenBot}
          onChanged={() => void ("author" in open ? community.refetch() : templates.refetch())}
        />
      );
    const firstParty = matches(templates.data);
    const fromCommunity = matches(shared);
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t`Search agents`}
            placeholder={t`Search agents`}
            maxLength={200}
            size="xl"
          />
          {categories.length >= 2 ? (
            <CategoryFilter
              categories={categories}
              chosen={category}
              label={categoryLabel}
              onChoose={setCategory}
            />
          ) : null}
        </div>
        {firstParty.length ? (
          <TemplateGroup
            key={`${category ?? "all"}:${query}`}
            title={t`From Superbot`}
            templates={firstParty}
            onOpen={(template) => setOpenId(template.id)}
          />
        ) : null}
        {fromCommunity.length ? (
          <TemplateGroup
            key={`community:${category ?? "all"}:${query}`}
            title={t`Community`}
            templates={fromCommunity}
            byline={(template) => sharedBy(template.author)}
            onOpen={(template) => setOpenId(template.id)}
          />
        ) : null}
        {firstParty.length || fromCommunity.length ? null : (
          <p className="px-2.5 text-body text-muted-foreground">
            <Trans>No agents match</Trans>
          </p>
        )}
        <MySharedTemplates />
      </div>
    );
  }

  return <div data-testid="bot-templates">{content()}</div>;
}

/** "All", the first few categories as chips, and the rest in a menu. */
function CategoryFilter({
  categories,
  chosen,
  label,
  onChoose,
}: {
  categories: readonly BotTemplateCategory[];
  chosen: BotTemplateCategory | null;
  label: (category: BotTemplateCategory) => string;
  onChoose: (category: BotTemplateCategory | null) => void;
}) {
  const chips = categories.slice(0, CHIP_COUNT);
  const rest = categories.slice(CHIP_COUNT);
  const restChosen = chosen !== null && rest.includes(chosen);
  return (
    <div className="flex flex-wrap gap-2" data-testid="bot-template-categories">
      {[null, ...chips].map((name) => (
        <Button
          key={name ?? "all"}
          type="button"
          variant={chosen === name ? "default" : "secondary"}
          aria-pressed={chosen === name}
          className="rounded-full px-3.5 text-body-sm"
          onClick={() => onChoose(name)}
        >
          {name ? label(name) : <Trans>All</Trans>}
        </Button>
      ))}
      {rest.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant={restChosen ? "default" : "secondary"}
                className="rounded-full px-3.5 text-body-sm"
              />
            }
          >
            {restChosen ? label(chosen) : <Trans>More</Trans>}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto">
            {rest.map((name) => (
              <DropdownMenuItem key={name} onClick={() => onChoose(name)}>
                {label(name)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** One titled group of template cards, a page at a time. */
export function TemplateGroup<T extends BotTemplateListing>({
  title,
  templates,
  byline,
  onOpen,
}: {
  title: string;
  templates: readonly T[];
  /** Who made each one, under its summary. */
  byline?: (template: T) => string;
  onOpen: (template: T) => void;
}) {
  const copy = useBotTemplateCopy();
  const cardId = useId();
  const [count, setCount] = useState(PAGE_SIZE);
  return (
    <section data-testid="bot-template-group" className="space-y-2">
      <SectionHeading as="h2" className="px-1">
        {title}
      </SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {templates.slice(0, count).map((template, index) => {
          const { name, summary, sample } = copy(template);
          const titleId = `${cardId}-${index}-title`;
          const summaryId = `${cardId}-${index}-summary`;
          return (
            <button
              key={template.id}
              type="button"
              data-testid="bot-template-card"
              aria-labelledby={titleId}
              aria-describedby={summaryId}
              onClick={() => onOpen(template)}
              className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 p-4 text-start focus-visible:outline-none ${ROW_HOVER}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <TemplateIcon template={template} />
                <span className="min-w-0 flex-1">
                  <span
                    id={titleId}
                    className="block truncate text-body-lg font-medium text-foreground"
                  >
                    {name}
                  </span>
                  <span
                    id={summaryId}
                    className="block truncate text-body-sm text-muted-foreground"
                  >
                    {summary}
                  </span>
                  {byline ? (
                    <span className="block truncate text-label text-muted-foreground">
                      {byline(template)}
                    </span>
                  ) : null}
                </span>
              </span>
              {/* A glimpse of the example; the template's page shows all of it. */}
              <span className="block h-40 overflow-hidden rounded-xl border border-border/60 bg-background px-3.5 py-2.5 text-body-sm mask-b-from-60%">
                <ChatMarkdown>{sample}</ChatMarkdown>
              </span>
            </button>
          );
        })}
      </div>
      {count < templates.length ? (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCount((shown) => shown + PAGE_SIZE)}
          >
            <Trans>Show more</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TemplateDetail({
  template,
  onBack,
  onOpenBot,
  onChanged,
}: {
  /** A community template carries its author, and its instructions show open. */
  template: BotTemplateListing | CommunityTemplateListing;
  onBack: () => void;
  onOpenBot: (bot: Bot) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const { name, summary, sample } = useBotTemplateCopy()(template);
  const sharedBy = useCommunityByline();
  const byline = "author" in template ? sharedBy(template.author) : null;
  // Someone else wrote a community template's instructions, so they show before creating.
  const [expanded, setExpanded] = useState<string | null>(byline ? "bot" : null);
  const open = useSave({
    save: async (input: { create: true } | { botId: string }, rpc) =>
      "botId" in input
        ? rpc.bots.get({ botId: input.botId })
        : (
            await rpc.bots.createFromTemplate({
              templateId: template.id,
              version: template.version,
              name,
            })
          ).bot,
    stale: (input) => ("botId" in input ? [] : [queries.bots.list.key()]),
    closesScreen: true,
    onSaved: (bot) => onOpenBot(bot),
    onFailed: (error, input) => {
      if (!("botId" in input) && isBotTemplateChanged(error)) onChanged();
    },
  });
  const pending = open.pending;
  const creating = !(open.input && "botId" in open.input);
  const error = open.error
    ? errorDetails(
        creating && isBotTemplateChanged(open.error)
          ? t`This template was just updated. Check it again.`
          : open.error,
        creating ? t`Could not create the bot` : t`Could not open the bot`,
      )
    : null;
  const catalog = useQuery({
    ...queries.connections.catalog.queryOptions({ input: {} }),
    enabled: template.apps.length > 0,
  });
  const apps = botTemplateApps(template, catalog.data ?? []);
  const schedule = (crons: string[]) =>
    crons.map((cron) => formatCron(cron, cronLabels(i18n.locale))).join(", ");

  const rows: { key: string; icon: LucideIcon; title: string; detail: string; body?: string }[] = [
    {
      key: "bot",
      icon: BotIcon,
      title: name,
      detail: t`Instructions`,
      body: template.instructions,
    },
    ...template.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      icon: ScrollText,
      title: skill.name,
      detail: t`Skill`,
      body: skill.body,
    })),
    ...template.routines.map((routine, index) => ({
      key: `routine:${index}`,
      icon: Clock,
      title: routine.name,
      detail: t`${schedule(routine.crons)}, paused until you turn it on`,
      body: routine.prompt,
    })),
  ];

  return (
    <div data-testid="bot-template-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={pending}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <TemplateIcon template={template} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">{name}</h2>
          <p className="truncate text-body text-muted-foreground">{summary}</p>
          {byline ? (
            <p
              data-testid="bot-template-author"
              className="truncate text-body-sm text-muted-foreground"
            >
              {byline}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 pt-2">
          {template.botId ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => open.run({ botId: template.botId! })}
            >
              <Trans>Open</Trans>
            </Button>
          ) : (
            <Button
              size="lg"
              className="px-5"
              disabled={pending}
              onClick={() => open.run({ create: true })}
            >
              {pending ? <Trans>Creating…</Trans> : <Trans>Create bot</Trans>}
            </Button>
          )}
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <Sample text={sample} />

      <section className="space-y-2">
        <SectionHeading className="px-1">
          <Trans>Adds</Trans>
        </SectionHeading>
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {rows.map((row) => {
            const Icon = row.icon;
            const isOpen = expanded === row.key;
            return (
              <li key={row.key}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : row.key)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start focus-visible:outline-none"
                >
                  <Icon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{row.title}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {row.detail}
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isOpen && row.body ? (
                  <div className="mx-4 mb-3 rounded-lg bg-background px-3.5 py-2.5 text-body-sm">
                    <ChatMarkdown>{row.body}</ChatMarkdown>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {apps.length ? <AppsSection apps={apps} /> : null}
    </div>
  );
}

function AppsSection({ apps }: { apps: ConnectionCatalogItem[] }) {
  const { t } = useLingui();
  return (
    <section className="space-y-2">
      <SectionHeading className="px-1">
        <Trans>Works with</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {apps.map((app) => (
          <li key={app.slug} className="flex items-center gap-3 px-4 py-3">
            <PluginLogo name={app.name} logo={app.logo} />
            <span className="min-w-0 flex-1 truncate text-body-lg font-medium">{app.name}</span>
            {app.connected ? (
              <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
