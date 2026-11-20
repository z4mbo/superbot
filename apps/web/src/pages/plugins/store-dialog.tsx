import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import type { connectedAppMarks } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Bot as BotIcon, LayoutGrid, Puzzle, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { BotTemplatesPanel } from "../../components/bot-templates/bot-templates-dialog";
import { SkillsPanel } from "../../components/integrations/skills-dialog";
import type { StoreSection } from "../shell/shell-overlay-url";
import { AppsSection } from "./apps-section";
import { CommunityStore } from "./community/community-store";
import type { PluginPick } from "./plugin-picks";

/** One Store: agent templates, skills, community plugins and app connections. */
export function StoreDialog({
  section,
  onSectionChange,
  onClose,
  activeBotId,
  onOpenBot,
  onOpenMcp,
  onOpenMessaging,
  onConnectedAppsChange,
}: {
  section: StoreSection;
  onSectionChange: (section: StoreSection) => void;
  onClose: () => void;
  activeBotId?: string;
  onOpenBot: (bot: Bot) => void;
  onOpenMcp?: () => void;
  onOpenMessaging?: () => void;
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
}) {
  const { t } = useLingui();
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [pluginPick, setPluginPick] = useState<{ key: number; pick?: PluginPick }>({ key: 0 });

  function open(next: StoreSection, pick?: PluginPick) {
    setPluginPick((now) => ({ key: now.key + 1, pick }));
    onSectionChange(next);
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="2xl" className="bg-card" data-testid="store">
        <DialogHeader className="gap-4 px-8 pt-7">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="text-heading2 text-foreground">
              <Trans>Store</Trans>
            </DialogTitle>
            <div className="flex items-center gap-2">
              <div ref={setActions} className="flex items-center gap-2" />
              <DialogClose
                render={<Button variant="ghost" size="icon-sm" aria-label={t`Close store`} />}
              >
                <X />
              </DialogClose>
            </div>
          </div>
          <Tabs value={section} onValueChange={(value) => open(value as StoreSection)}>
            <TabsList aria-label={t`Store sections`}>
              <TabsTrigger value="agents" className="px-3" data-testid="store-agents">
                <BotIcon />
                <Trans>Agents</Trans>
              </TabsTrigger>
              <TabsTrigger value="skills" className="px-3" data-testid="store-skills">
                <Sparkles />
                <Trans>Skills</Trans>
              </TabsTrigger>
              <TabsTrigger value="plugins" className="px-3" data-testid="store-plugins">
                <Puzzle />
                <Trans>Plugins</Trans>
              </TabsTrigger>
              <TabsTrigger value="apps" className="px-3" data-testid="store-apps">
                <LayoutGrid />
                <Trans>Apps</Trans>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </DialogHeader>
        {section === "apps" ? (
          <AppsSection
            actions={actions}
            activeBotId={activeBotId}
            onConnectedAppsChange={onConnectedAppsChange}
            onOpenMcp={onOpenMcp}
            onOpenMessaging={onOpenMessaging}
            onOpenPlugins={(pick) => open("plugins", pick)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">
            {section === "agents" ? <BotTemplatesPanel onOpenBot={onOpenBot} /> : null}
            {section === "skills" ? (
              <SkillsPanel actions={actions} activeBotId={activeBotId} />
            ) : null}
            {section === "plugins" ? (
              <CommunityStore
                key={pluginPick.key}
                activeBotId={activeBotId}
                initialPick={pluginPick.pick}
                onOpenApps={() => open("apps")}
              />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
