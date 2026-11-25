import { Trans, useLingui } from "@lingui/react/macro";
import { Button, toast } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { WindowChrome } from "../../components/WindowChrome";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { useCloudAccounts } from "../accounts/cloud-accounts-context";

/** A whole page of the hosted site outside the app, laid out like the server's own sign-in. */
export function CloudPage({
  leading,
  trailing,
  center = true,
  children,
  ...props
}: {
  /** At the start of the top bar. */
  leading?: ReactNode;
  /** At the end of the top bar. */
  trailing?: ReactNode;
  /** Centred in the window; off for a list that grows downward. */
  center?: boolean;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div
      className="flex min-h-full flex-col bg-background text-foreground"
      data-rakazo-surface="auth"
      {...props}
    >
      <div className="app-drag flex min-h-[68px] items-center gap-2 px-5 py-[18px]">
        <WindowChrome />
        {leading ? <div className="app-no-drag flex items-center">{leading}</div> : null}
        {trailing ? <div className="app-no-drag ms-auto flex items-center">{trailing}</div> : null}
      </div>
      <div
        className={`flex flex-1 justify-center px-4 pb-16 sm:px-6 ${
          center ? "items-center" : "items-start pt-[8vh]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function SuperbotMark({ size = 56 }: { size?: number }) {
  return <img src="/superbot-mark.svg" alt="" width={size} height={size} />;
}

/** The signed-in cloud account and the way out of it. */
export function useCloudSignOut() {
  const { t } = useLingui();
  const accounts = useCloudAccounts();
  const account = accounts.useAccount();
  const signOut = useSave({
    save: () => accounts.signOut(),
    onFailed: (error) => toast.error(errorText(error, t`Could not sign out`)),
  });
  return {
    email: account.status === "signed-in" ? account.user.email : null,
    signOut: () => signOut.run(),
    pending: signOut.pending,
  };
}

/** Top-right on the full pages: who is signed in, and Sign out. */
export function CloudAccountMenu() {
  const { email, signOut, pending } = useCloudSignOut();
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="cloud-account">
      {email ? (
        <span className="hidden truncate text-body-sm text-muted-foreground sm:inline">
          {email}
        </span>
      ) : null}
      <Button variant="text" size="sm" disabled={pending} onClick={signOut}>
        <Trans>Sign out</Trans>
      </Button>
    </div>
  );
}

/** The workspace list could not be read. */
export function CloudWorkspacesFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="grid h-full place-items-center bg-background px-6 text-center"
      data-testid="cloud-workspaces-failed"
    >
      <div className="flex flex-col items-center">
        <p className="text-body text-muted-foreground/80">
          <Trans>Could not load your workspaces.</Trans>
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={onRetry}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
