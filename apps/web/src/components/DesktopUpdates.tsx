import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { DesktopUpdateState } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SectionHeading,
  toast,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../lib/platform/desktop";

function useDesktopUpdates() {
  const { t } = useLingui();
  const bridge = desktopBridge()?.update;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);

  // Each finished read schedules the next one, two seconds on.
  const [nextRefresh, setNextRefresh] = useState<object | null>(null);
  async function refresh() {
    if (!bridge) return;
    const started = revision.current;
    try {
      const next = await bridge.state();
      if (started === revision.current && !pending.current) {
        setState((current) =>
          current &&
          Object.entries(next).every(
            ([key, value]) => current[key as keyof DesktopUpdateState] === value,
          )
            ? current
            : next,
        );
      }
    } catch {
      // A disappearing bridge during shutdown should not interrupt the app.
    } finally {
      setNextRefresh({});
    }
  }
  useEffect(() => {
    void refresh();
  }, [bridge]);
  useTimeout(() => void refresh(), bridge && nextRefresh ? 2_000 : null, nextRefresh);

  async function act(action: "check" | "download" | "install") {
    if (!bridge || pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError(null);
    if (action === "check") setConfirmedCheck(null);
    try {
      const next = await bridge[action]();
      setState(next);
      if (
        action === "check" &&
        next.phase === "idle" &&
        !next.message &&
        next.checkedAt !== state?.checkedAt
      ) {
        setConfirmedCheck(next.checkedAt);
      }
      if (next.phase === "error" || action === "install") {
        setError(next.message);
      }
    } catch {
      setError(t`Could not complete the update. Try again.`);
    } finally {
      revision.current++;
      pending.current = false;
      setBusy(false);
    }
  }
  return { state, busy, error, act, confirmedCheck };
}

/** A newer release the user can act on: being fetched, ready to install, or to download. */
function offered(state: DesktopUpdateState | null): state is DesktopUpdateState & {
  availableVersion: string;
} {
  return (
    state?.availableVersion != null &&
    (state.phase === "available" || state.phase === "downloading" || state.phase === "ready")
  );
}

type DesktopUpdates = ReturnType<typeof useDesktopUpdates> & {
  /** Shows the offered release's notes and its install action. */
  openRelease: () => void;
};

const UpdatesContext = createContext<DesktopUpdates | null>(null);

const DESKTOP_UPDATE_TOAST = "desktop-update";

export function DesktopUpdatesProvider({ children }: { children: ReactNode }) {
  const updates = useDesktopUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const { state, error } = updates;
  useEffect(() => {
    if (error) setDismissed(null);
  }, [error]);
  // A system package never reaches `ready`, so its offer prompts as soon as it is found.
  const manualOffer = offered(state) && state.phase === "available" && state.manualInstall === true;
  const prompt = Boolean(
    state &&
      (state.phase === "ready" || manualOffer || (error && state.availableVersion)) &&
      dismissed !== state.availableVersion,
  );
  // Keep the toast up while a retry runs, so a quick failure reuses it instead of racing
  // its dismissal.
  const [shown, setShown] = useState(false);
  const visible = prompt || (shown && updates.busy);
  useEffect(() => {
    setShown(visible);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    // The app's Toaster renders inside this provider, so the toast reads live state from context.
    toast.custom(() => <DesktopUpdatePrompt onLater={setDismissed} />, {
      id: DESKTOP_UPDATE_TOAST,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
    });
    return () => {
      toast.dismiss(DESKTOP_UPDATE_TOAST);
    };
  }, [visible]);
  return (
    <UpdatesContext.Provider value={{ ...updates, openRelease: () => setReleaseOpen(true) }}>
      {children}
      {offered(state) ? (
        <DesktopReleaseDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          onLater={() => {
            setReleaseOpen(false);
            setDismissed(state.availableVersion);
          }}
        />
      ) : null}
    </UpdatesContext.Provider>
  );
}

function DesktopReleaseDialog({
  open,
  onOpenChange,
  onLater,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLater: () => void;
}) {
  const updates = useContext(UpdatesContext);
  if (!updates || !offered(updates.state)) return null;
  const { state, busy, error, act } = updates;
  const ready = state.phase === "ready";
  const manual = state.manualInstall === true && !ready;
  const downloading = !ready && !manual;
  const status =
    error ?? state.message ?? (downloading && state.percent !== null ? `${state.percent}%` : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Update available</Trans>
          </DialogTitle>
          <DialogDescription>v{state.availableVersion}</DialogDescription>
        </DialogHeader>
        {state.releaseNotes ? (
          // Untrusted text from the release host: shown as text, never parsed as markup.
          <div
            data-testid="desktop-release-notes"
            className="max-h-80 overflow-y-auto text-body break-words whitespace-pre-line"
          >
            {state.releaseNotes}
          </div>
        ) : null}
        {status ? (
          <p role="status" className="text-body text-muted-foreground">
            {status}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onLater}>
            <Trans>Later</Trans>
          </Button>
          <Button
            disabled={busy || downloading}
            onClick={() => {
              if (manual) onLater();
              void act(ready ? "install" : "download");
            }}
          >
            {ready ? (
              <Trans>Restart to update</Trans>
            ) : manual ? (
              <Trans>Download</Trans>
            ) : (
              <Trans>Downloading…</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DesktopUpdatePrompt({ onLater }: { onLater: (version: string | null) => void }) {
  const { t } = useLingui();
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act, openRelease } = updates;
  const manualOffer = state.phase === "available" && state.manualInstall === true;
  return (
    <aside
      aria-label={t`Desktop update`}
      className="w-full rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            if (manualOffer) openRelease();
            else void act(state.phase === "ready" ? "install" : "check");
          }}
        >
          {state.phase === "ready" ? (
            <Trans>Restart to update</Trans>
          ) : manualOffer ? (
            <Trans>Update available</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onLater(state.availableVersion)}>
          <Trans>Later</Trans>
        </Button>
      </div>
      {error || state.message ? (
        <p role="status" className="mt-2 text-body">
          {error ?? state.message}
        </p>
      ) : null}
    </aside>
  );
}

export function useSidebarUpdate() {
  const updates = useContext(UpdatesContext);
  return {
    available: offered(updates?.state ?? null),
    open: () => updates?.openRelease(),
  };
}

export function DesktopUpdateSection() {
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act, confirmedCheck } = updates;
  const ready = state.phase === "ready";
  const manualOffer = state.phase === "available" && state.manualInstall === true;
  const downloading =
    !manualOffer && (state.phase === "available" || state.phase === "downloading");
  return (
    <section
      data-testid="desktop-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <SectionHeading variant="heading">
        <Trans>Desktop app</Trans>
      </SectionHeading>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-body text-muted-foreground">v{state.currentVersion}</span>
        <Button
          variant="outline"
          disabled={busy || downloading || state.phase === "checking"}
          onClick={() => void act(ready ? "install" : manualOffer ? "download" : "check")}
        >
          {ready ? (
            <Trans>Restart to update</Trans>
          ) : manualOffer ? (
            <Trans>Download</Trans>
          ) : downloading ? (
            <Trans>Downloading…</Trans>
          ) : busy || state.phase === "checking" ? (
            <Trans>Checking…</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
      </div>
      <p role="status" className="mt-2 text-body text-muted-foreground">
        {error ??
          state.message ??
          (downloading ? (
            `${state.percent ?? 0}%`
          ) : state.phase === "idle" && confirmedCheck && state.checkedAt === confirmedCheck ? (
            <Trans>Up to date</Trans>
          ) : null)}
      </p>
    </section>
  );
}
