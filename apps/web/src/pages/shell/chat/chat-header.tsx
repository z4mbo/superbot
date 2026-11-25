import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { MEETING_CALENDAR_RETURN_PARAM } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { Gift, Menu, Video } from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useBilling } from "../../../components/billing/SubscriptionGate";
import { IconTooltip } from "../../../components/IconTooltip";
import { InviteDialog } from "../../../components/spaces/InviteDialog";
import { WindowChrome } from "../../../components/WindowChrome";
import { desktopBridge, windowChromeKind } from "../../../lib/platform/desktop";

const MeetingsDialog = lazy(() => import("../meetings/meetings-dialog"));

/** The floating header over the transcript: navigation, the chat's name and invite. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  meetingsEnabled,
  panelOpen,
  onOpenNavigation,
  onTogglePanel,
  modelPicker,
  workspacePicker,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  meetingsEnabled?: boolean;
  panelOpen: boolean;
  onOpenNavigation: () => void;
  onTogglePanel: () => void;
  /** The bot's model, shown inside the capsule beside its name. */
  modelPicker?: ReactNode;
  /** The chat's workspace, shown inside the capsule after the model. */
  workspacePicker?: ReactNode;
}) {
  const { t } = useLingui();
  const referral = useBilling().status?.referral;
  const [inviteOpen, setInviteOpen] = useState(false);
  const macChrome = windowChromeKind(desktopBridge()) === "darwin";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 py-2.5 md:px-[22px] [&_button]:pointer-events-auto">
      <div className="flex items-center">
        {macChrome ? <WindowChrome className="md:hidden" /> : null}
        <Button
          variant="floating"
          size="icon-lg"
          aria-label={t`Open navigation`}
          onClick={onOpenNavigation}
          className="app-no-drag md:hidden"
        >
          <Menu strokeWidth={1.75} className="size-4.5" />
        </Button>
      </div>
      {/* With no bot or group the chip has nothing to open, so it is left out. */}
      {inGroup || active ? (
        // The chat's capsule: its name opens the details, and beside the name sit the bot's
        // model and the workspace the chat lives in.
        <div
          data-testid="chat-capsule"
          className="app-no-drag pointer-events-auto flex h-[41px] min-w-0 items-center gap-0.5 rounded-full border border-hairline bg-elevated pe-[5.5px] shadow-floating"
        >
          <button
            type="button"
            data-testid="bot-settings-trigger"
            aria-expanded={panelOpen}
            onClick={onTogglePanel}
            className={`flex h-full min-w-0 items-center gap-2 rounded-full ps-[7.5px] outline-none transition-colors hover:bg-elevated-hover focus-visible:ring-2 focus-visible:ring-ring ${
              modelPicker || workspacePicker ? "pe-2" : "-me-[5.5px] pe-[13.5px]"
            }`}
          >
            {inGroup ? (
              <GroupAvatar
                members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                size={24}
              />
            ) : active ? (
              <BotAvatar
                avatarSet={active.avatarSet}
                color={active.color}
                identity={active.id}
                size={24}
                status={active.status}
              />
            ) : null}
            <span
              className="block min-w-0 truncate text-body font-medium text-foreground"
              dir="auto"
            >
              {inGroup
                ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                : active?.name}
            </span>
          </button>
          {modelPicker}
          {workspacePicker}
        </div>
      ) : (
        <div />
      )}
      <div className="flex items-center justify-self-end gap-2">
        {meetingsEnabled && !inGroup && active ? (
          <MeetingsControl key={active.id} botId={active.id} />
        ) : null}
        {referral && !inGroup && active ? (
          <IconTooltip label={t`Invite a friend`}>
            <Button
              variant="floating"
              size="icon-lg"
              aria-label={t`Invite a friend`}
              onClick={() => setInviteOpen(true)}
              className="app-no-drag"
            >
              <Gift strokeWidth={1.75} className="size-4.5" />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      {referral ? (
        <InviteDialog referral={referral} open={inviteOpen} onOpenChange={setInviteOpen} />
      ) : null}
    </div>
  );
}

function MeetingsControl({ botId }: { botId: string }) {
  const { t } = useLingui();
  const { botId: routeBotId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const returningToCalendar =
    routeBotId === botId && searchParams.get(MEETING_CALENDAR_RETURN_PARAM) === "1";
  const [view, setView] = useState<"closed" | "meetings" | "calendar">(
    returningToCalendar ? "calendar" : "closed",
  );
  useEffect(() => {
    if (!returningToCalendar) return;
    const next = new URLSearchParams(searchParams);
    next.delete(MEETING_CALENDAR_RETURN_PARAM);
    setSearchParams(next, { replace: true });
  }, [returningToCalendar, searchParams, setSearchParams]);
  return (
    <>
      <IconTooltip label={t`Meetings`}>
        <Button
          variant="floating"
          size="icon-lg"
          aria-label={t`Meetings`}
          onClick={() => setView("meetings")}
          className="app-no-drag"
        >
          <Video strokeWidth={1.75} className="size-4.5" />
        </Button>
      </IconTooltip>
      {view !== "closed" ? (
        <Suspense>
          <MeetingsDialog
            botId={botId}
            showCalendar={view === "calendar"}
            onClose={() => setView("closed")}
          />
        </Suspense>
      ) : null}
    </>
  );
}
