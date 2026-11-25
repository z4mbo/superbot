import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { MEETING_CALENDAR_RETURN_PARAM } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { ChevronRight, Gift, Menu, Video } from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useBilling } from "../../../components/billing/SubscriptionGate";
import { IconTooltip } from "../../../components/IconTooltip";
import { InviteDialog } from "../../../components/spaces/InviteDialog";
import { WindowChrome } from "../../../components/WindowChrome";

const MeetingsDialog = lazy(() => import("../meetings/meetings-dialog"));

/** The floating header over the transcript: navigation, the chat's name and invite. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  meetingsEnabled,
  panelOpen,
  sidePanelShown,
  onOpenNavigation,
  onTogglePanel,
  modelPicker,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  meetingsEnabled?: boolean;
  /** Whether the chat's own details panel is open, which the capsule toggles. */
  panelOpen: boolean;
  /** Whether any panel shows beside the chat, so the window's top right corner is the panel's. */
  sidePanelShown: boolean;
  onOpenNavigation: () => void;
  onTogglePanel: () => void;
  /** The bot's model, shown inside the capsule beside its name. */
  modelPicker?: ReactNode;
}) {
  const { t } = useLingui();
  const referral = useBilling().status?.referral;
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    // The toolbar drags the window, as the reference's does.
    <div className="app-drag pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 py-2.5 md:px-[22px] [&_button]:pointer-events-auto">
      <div className="flex items-center">
        <WindowChrome className="md:hidden" />
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
        // The chat's capsule: its name opens the details, and the bot's model sits beside it.
        <div
          data-testid="chat-capsule"
          className={`app-no-drag pointer-events-auto flex h-[41px] min-w-0 items-center gap-0.5 rounded-full border border-hairline bg-elevated shadow-floating ${
            modelPicker ? "pe-[5.5px]" : ""
          }`}
        >
          <button
            type="button"
            data-testid="bot-settings-trigger"
            aria-expanded={panelOpen}
            onClick={onTogglePanel}
            className={`group/capsule flex h-full min-w-0 items-center gap-2 rounded-full ps-[7.5px] outline-none transition-colors hover:bg-elevated-hover focus-visible:ring-2 focus-visible:ring-ring ${
              modelPicker ? "pe-2" : "pe-[13.5px] hover:pe-[9.5px] focus-visible:pe-[9.5px]"
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
            {/* Alone in the capsule, the name shows where it leads once pointed at. */}
            {modelPicker ? null : (
              <ChevronRight
                aria-hidden="true"
                strokeWidth={1.75}
                className="hidden size-3 shrink-0 text-muted-foreground group-hover/capsule:block group-focus-visible/capsule:block"
              />
            )}
          </button>
          {modelPicker}
        </div>
      ) : (
        <div />
      )}
      {/* Clear of window controls at the window's top right, unless a side panel is there. */}
      <div
        className="flex items-center justify-self-end gap-2"
        style={
          sidePanelShown ? undefined : { paddingInlineEnd: "var(--window-controls-inset, 0px)" }
        }
      >
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
