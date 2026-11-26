import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import type { Bot, PageSummary, SearchHit } from "@rakazo/contracts";
import { searchHitListKey } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Kbd,
} from "@rakazo/ui-web";
import { Check, MessageSquare } from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useEventListener } from "../../lib/use-event-listener";
import { isApplePlatform } from "./shell-shortcuts";

/** Pages listed before anything is typed. */
const RECENT_PAGES = 5;

/** Group headings line up with the rows' avatars, at regular weight as in the reference. */
const GROUP = "**:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:font-normal";
const ROW = "items-center gap-3 rounded-xl! px-3 py-2";

export type CommandPaletteAction = {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  checked?: boolean;
  onSelect: () => void;
};

/** What the Space search found for the typed text: messages, files and group chats. */
export type CommandPaletteChats = {
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (hit: SearchHit) => void;
};

function botSearchText(bot: Bot) {
  return `${bot.name} ${bot.description} ${bot.preview}`.toLowerCase();
}

function botSubtitle(bot: Bot) {
  return bot.description.trim() || bot.preview.trim();
}

export function CommandPalette({
  open,
  onOpenChange,
  bots,
  onSelectBot,
  actions,
  pages = [],
  onSelectPage,
  onSearchChange,
  chats,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  onSelectBot: (botId: string) => void;
  actions: CommandPaletteAction[];
  /** Pages bots built in this Space. */
  pages?: PageSummary[];
  onSelectPage?: (page: PageSummary) => void;
  /** The typed search, so pages beyond the first loaded can be asked for. */
  onSearchChange?: (search: string) => void;
  /** The Space search for the typed text; bots it finds are already listed above it. */
  chats?: CommandPaletteChats;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => onSearchChange?.(search), [search, onSearchChange]);
  const [modKey, setModKey] = useState("⌘");

  useEffect(() => {
    setModKey(isApplePlatform() ? "⌘" : "Ctrl");
  }, []);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredBots = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return bots;
    return bots.filter((bot) => botSearchText(bot).includes(needle));
  }, [bots, search]);

  const filteredActions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(needle));
  }, [actions, search]);

  // Without a search only the latest few pages show, so actions stay in reach; with one, titles
  // that start with it come first, and if one does the pages lead the menu.
  const needle = search.trim().toLowerCase();
  const filteredPages = useMemo(() => {
    if (!needle) return pages.slice(0, RECENT_PAGES);
    const starts = (page: PageSummary) => page.title.toLowerCase().startsWith(needle);
    return pages
      .filter((page) => page.title.toLowerCase().includes(needle))
      .sort((a, b) => Number(starts(b)) - Number(starts(a)));
  }, [pages, needle]);
  const pagesFirst =
    needle !== "" && filteredPages.some((page) => page.title.toLowerCase().startsWith(needle));
  const pagesGroup =
    filteredPages.length > 0 && onSelectPage ? (
      <CommandGroup heading={t`Pages`} className={GROUP}>
        {filteredPages.map((page) => (
          <CommandItem
            key={page.id}
            value={`page:${page.id}`}
            onSelect={() => {
              onOpenChange(false);
              onSelectPage(page);
            }}
            className={ROW}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-muted">
              <PageIcon className="h-[17px] w-[13px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground" dir="auto">
                {page.title}
              </span>
              <span className="mt-0.5 block truncate text-body-sm text-muted-foreground">
                {formatRelativeTime(page.updatedAt)}
              </span>
            </span>
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null;
  // A bot's own chat is the bot row above, so only what lies inside chats is listed here.
  const chatHits =
    needle && chats
      ? chats.hits.filter((hit) => !(hit.kind === "conversation" && !hit.groupId))
      : [];
  const chatsGroup =
    needle && chats && (chatHits.length > 0 || chats.error) ? (
      <CommandGroup heading={t`Chats`} className={GROUP}>
        {chats.error ? (
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <p role="alert" className="min-w-0 text-body text-destructive">
              {chats.error}
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={chats.onRetry}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : (
          chatHits.map((hit) => {
            const key = searchHitListKey(hit);
            return (
              <CommandItem
                key={key}
                value={`chat:${key}`}
                onSelect={() => {
                  onOpenChange(false);
                  chats.onSelect(hit);
                }}
                className={ROW}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <MessageSquare size={16} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground" dir="auto">
                    {hit.title}
                  </span>
                  <span
                    className="mt-0.5 flex min-w-0 gap-2 text-body-sm text-muted-foreground"
                    dir="auto"
                  >
                    <span className="max-w-[40%] shrink-0 truncate text-foreground/75">
                      {hit.groupName ?? hit.botName}
                    </span>
                    <span className="truncate">{hit.snippet}</span>
                  </span>
                </span>
              </CommandItem>
            );
          })
        )}
      </CommandGroup>
    ) : null;
  useEventListener(open ? window : null, "keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    const bot = filteredBots[Number(event.key) - 1];
    if (!bot) return;
    event.preventDefault();
    onSelectBot(bot.id);
    onOpenChange(false);
  });

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`Command menu`}
      description={t`Search bots, actions, and settings`}
      className="sm:max-w-[640px]"
    >
      <Command
        shouldFilter={false}
        className="rounded-[18px]! bg-popover p-0"
        data-testid="command-palette"
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={t`Search Bots, Chats, Settings…`}
          size="xl"
          // off-scale: the palette's search is its title line, larger than any field (reference 20px).
          className="text-[20px]/7"
          data-testid="command-palette-search"
        />
        <CommandList className="max-h-[488px] px-1 pb-1" data-testid="command-palette-list">
          {/* Nothing found yet is not "No results" while chats are still being searched or failed. */}
          {needle && (chats?.loading || chats?.error) ? null : (
            <CommandEmpty>
              <Trans>No results</Trans>
            </CommandEmpty>
          )}
          {pagesFirst ? pagesGroup : null}
          {filteredBots.length > 0 ? (
            <CommandGroup heading={t`Bots`} className={GROUP}>
              {filteredBots.map((bot, index) => {
                const subtitle = botSubtitle(bot);
                const shortcut = index < 9 ? `${modKey}${index + 1}` : null;
                return (
                  <CommandItem
                    key={bot.id}
                    value={bot.id}
                    data-testid={`command-palette-bot-${bot.id}`}
                    onSelect={() => {
                      onSelectBot(bot.id);
                      onOpenChange(false);
                    }}
                    className={ROW}
                  >
                    <BotAvatar
                      avatarSet={bot.avatarSet}
                      color={bot.color}
                      identity={bot.id}
                      size={28}
                      status={bot.status}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground" dir="auto">
                        {bot.name}
                      </div>
                      {subtitle ? (
                        <div
                          className="mt-0.5 truncate text-body-sm text-muted-foreground"
                          dir="auto"
                        >
                          {subtitle}
                        </div>
                      ) : null}
                    </div>
                    {shortcut ? (
                      <CommandShortcut className="tracking-normal">
                        <Kbd>{shortcut}</Kbd>
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          {chatsGroup}
          {pagesFirst ? null : pagesGroup}
          {filteredActions.length > 0 ? (
            <CommandGroup>
              {filteredActions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action.id}
                  aria-checked={action.checked}
                  data-testid={`command-palette-action-${action.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    action.onSelect();
                  }}
                  className={ROW}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <action.icon size={16} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{action.label}</span>
                  {action.checked ? (
                    <Check
                      size={16}
                      strokeWidth={1.8}
                      className="text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
