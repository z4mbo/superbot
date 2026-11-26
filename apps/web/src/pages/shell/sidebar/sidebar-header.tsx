import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Plus, Search } from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import { WindowChrome } from "../../../components/WindowChrome";
import { BotCreatePicker } from "../bots/bot-picker";
import type { Panel } from "../right-panel-state";

// A size class, since the Button sizes any svg without one to 16px.
const ICON = "size-4.5";
const STROKE = 1.75;

export function SidebarHeader({
  createMenuOpen,
  setCreateMenuOpen,
  searchOpen = false,
  onSearch,
  bots,
  setMobileSidebarOpen,
  setPanel,
  navigate,
  setNewSpaceOpen,
  setCreateBotOpen,
}: {
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  searchOpen?: boolean;
  onSearch?: () => void;
  bots: Bot[];
  setMobileSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  setCreateBotOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="group/sidebar-header app-drag flex h-15 shrink-0 items-center justify-between gap-2 px-4 py-3">
      {/* Keeps the macOS traffic lights clear; elsewhere the window controls sit at the top right. */}
      <WindowChrome />
      <div className="relative ms-auto flex items-center gap-2">
        {onSearch ? (
          <IconTooltip label={t`Search`}>
            <Button
              variant="floating"
              size="icon-lg"
              aria-label={t`Search`}
              aria-pressed={searchOpen}
              data-testid="sidebar-search-trigger"
              onClick={onSearch}
              className="app-no-drag"
            >
              <Search className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`}>
            <PopoverTrigger
              render={<Button variant="floating" size="icon-lg" className="app-no-drag" />}
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
            >
              <Plus className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </PopoverTrigger>
          </IconTooltip>
          {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
          {createMenuOpen ? (
            <PopoverContent
              align="end"
              className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
            >
              <BotCreatePicker
                bots={bots}
                onCreateBot={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setCreateBotOpen(true);
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setPanel("create-group");
                }}
                onCreateSpace={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setNewSpaceOpen(true);
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}
