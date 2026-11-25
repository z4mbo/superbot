import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { computerPreviewPlaceholder } from "@rakazo/i18n/computer-preview";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { HardDrive, X } from "lucide-react";
import type { ReactNode } from "react";
import { ComputersUnavailableHint } from "../../../components/computers/ComputersUnavailableHint";
import { runsOnUserMachine } from "../../../lib/computers/computer-sandbox";
import { screenFrames, screenIframeSandbox } from "../../../lib/computers/computer-screen";
import { computerLabel, DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  booting: boolean;
  showingRecoveryHint: boolean;
  showComputerRecoveryHint: boolean;
  sandboxProvider?: string | null;
  onRecovered: (sandboxProvider: string) => void;
  onRecoveryDismissed: () => void;
  onOpenComputerSettings?: () => void;
  onOpen: () => void;
  cleaningUpDisk?: boolean;
  onCleanUpDisk?: () => void;
  onDismissDiskWarning?: () => void;
};

/** The bot's computer as one row of a panel card: its name, its state and a small preview. */
export function ComputerPanel({
  cleaningUpDisk,
  onCleanUpDisk,
  onDismissDiskWarning,
  ...props
}: ComputerPanelProps) {
  const percent = props.computer?.diskFullPercent;
  const warn = percent !== undefined && onCleanUpDisk && onDismissDiskWarning;
  // The preview keeps its place either way, so the warning never remounts the live screen.
  return (
    <>
      <ComputerPreview {...props} />
      {warn && (
        <div
          data-testid="computer-disk-warning"
          className="flex items-center gap-2 border-t border-border py-1.5 ps-3 pe-1.5 text-body"
        >
          <HardDrive aria-hidden size={15} strokeWidth={1.9} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <Trans>Computer is {percent}% full</Trans>
          </span>
          <Button variant="secondary" size="sm" disabled={cleaningUpDisk} onClick={onCleanUpDisk}>
            <Trans>Clean up</Trans>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            onClick={onDismissDiskWarning}
          >
            <X size={15} aria-hidden />
          </Button>
        </div>
      )}
    </>
  );
}

function ComputerPreview({
  bot,
  computer,
  computerOpen,
  embeddedScreenUrl,
  screenFrameKey,
  heldScreen,
  screenFrameRef,
  computerScreenError,
  booting,
  showingRecoveryHint,
  showComputerRecoveryHint,
  sandboxProvider,
  onRecovered,
  onRecoveryDismissed,
  onOpenComputerSettings,
  onOpen,
}: Omit<ComputerPanelProps, "cleaningUpDisk" | "onCleanUpDisk" | "onDismissDiskWarning">) {
  const onUserMachine = runsOnUserMachine(computer);
  const idle =
    !computerOpen &&
    !booting &&
    !computerScreenError &&
    !showComputerRecoveryHint &&
    !onUserMachine &&
    (!computer || computer.state === "stopped" || computer.state === "suspended");
  const liveScreen =
    !computerOpen &&
    !onUserMachine &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const recoveryHint =
    !computerOpen &&
    !onUserMachine &&
    !liveScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;
  // An error or the recovery hint carries its own actions, so it shows under the row.
  const detail =
    !computerOpen && !onUserMachine && !liveScreen
      ? (computerScreenError ??
        (recoveryHint ? (
          <ComputersUnavailableHint
            sandboxProvider={sandboxProvider}
            onRecovered={onRecovered}
            onRecoveryDismissed={onRecoveryDismissed}
            onOpenComputerSettings={onOpenComputerSettings}
          />
        ) : null))
      : null;
  const state: ReactNode = computerOpen ? (
    <Trans>Open in full window</Trans>
  ) : onUserMachine ? (
    <DesktopKindEmptyState />
  ) : liveScreen ? (
    <Trans>Running</Trans>
  ) : idle ? (
    <Trans>Asleep</Trans>
  ) : (
    computerPreviewPlaceholder(computer?.state, booting)
  );
  const canOpen = !computerScreenError && !showingRecoveryHint;
  return (
    <div
      data-testid="computer-preview"
      data-state={
        idle ? "idle" : computer?.state === "running" && !onUserMachine ? "running" : undefined
      }
    >
      <div className="relative flex items-center gap-3 px-3 py-2.5 has-[button:hover]:bg-accent">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-foreground" dir="auto">
            {computerLabel(computer?.mode, bot.name)}
          </div>
          <div className="line-clamp-2 text-body-sm text-muted-foreground">{state}</div>
        </div>
        <div
          data-testid="computer-preview-thumbnail"
          className="relative grid aspect-[16/10] w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-muted"
        >
          {liveScreen && embeddedScreenUrl ? (
            screenFrames(screenFrameKey, embeddedScreenUrl, heldScreen).map((frame) => (
              // Laid out at four times the thumbnail and scaled down, so the screen fits whole.
              <iframe
                key={frame.key}
                title={frame.held ? undefined : t`Bot screen preview`}
                aria-hidden={frame.held || undefined}
                tabIndex={-1}
                ref={frame.held ? undefined : screenFrameRef}
                src={frame.url}
                sandbox={screenIframeSandbox(frame.url)}
                className="absolute inset-0 h-[400%] w-[400%] origin-top-left scale-25 border-0 bg-black"
                allow="clipboard-read; clipboard-write"
                style={{ pointerEvents: "none" }}
              />
            ))
          ) : (
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={22}
              {...(idle ? { state: "asleep" as const } : { status: bot.status })}
            />
          )}
        </div>
        {canOpen ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            // A whole-row button: the name and state above are what it opens.
            className="absolute inset-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={onOpen}
          >
            <span className="sr-only">{idle ? <Trans>Wake</Trans> : <Trans>Open</Trans>}</span>
          </button>
        ) : null}
      </div>
      {detail ? (
        <div className="border-t border-border px-3 py-3 text-center text-body-sm text-muted-foreground">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
