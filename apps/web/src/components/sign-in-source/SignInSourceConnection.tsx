import { Trans, useLingui } from "@lingui/react/macro";
import type { SignInSourceState } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { useEventListener } from "../../lib/use-event-listener";
import { ConfirmDialog } from "../ConfirmDialog";
import { openSignInLink } from "./open-sign-in-link";

/**
 * The person's password manager connection, which lets bots sign in to sites with logins the
 * person approves in its app. Nothing shows when the deployment offers none.
 */
export function SignInSourceConnection() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.signInSource.status.queryOptions();
  const statusQuery = useQuery(statusOptions);
  const source = statusQuery.data;
  // The provider's page finishes the connection in another tab; coming back reads it again.
  useEventListener(window, "focus", () => {
    if (source?.status === "connecting") void statusQuery.refetch();
  });
  const [confirming, setConfirming] = useState(false);
  const connect = useSave({
    save: (_: void, rpc) => rpc.signInSource.connect(),
    stale: [statusOptions.queryKey],
    onSaved: ({ authorizeUrl }) => openSignInLink(authorizeUrl),
  });
  const disconnect = useSave({
    save: async (_: void, rpc) => {
      const next = await rpc.signInSource.disconnect();
      await writeSaved(queryClient, statusOptions.queryKey, () => next);
      return next;
    },
    onSaved: () => setConfirming(false),
    onFailed: () => setConfirming(false),
  });
  if (!source) return null;
  const label = source.label;
  const pending = connect.pending || disconnect.pending;
  const error = connect.error
    ? errorText(connect.error, t`Couldn't connect ${label}`)
    : disconnect.error
      ? errorText(disconnect.error, t`Couldn't disconnect ${label}`)
      : null;
  return (
    <section data-testid="sign-in-source" data-status={source.status}>
      <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-foreground">
          <KeyRound aria-hidden="true" className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium">{label}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            <SourceStatus source={source} />
          </span>
        </span>
        {source.status === "connected" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trans>Disconnect</Trans>
          </Button>
        ) : source.connectable ? (
          <Button size="sm" disabled={pending} onClick={() => connect.run()}>
            <Trans>Connect</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="px-2.5 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          onCancel={() => setConfirming(false)}
          title={t`Disconnect ${label}?`}
          busy={disconnect.pending}
          onConfirm={() => disconnect.run()}
          confirmLabel={<Trans>Disconnect</Trans>}
        />
      ) : null}
    </section>
  );
}

function SourceStatus({ source }: { source: SignInSourceState }) {
  if (!source.connectable && source.status !== "connected") return <Trans>Not available yet</Trans>;
  switch (source.status) {
    case "connected":
      return <Trans>Bots sign in with logins you approve</Trans>;
    case "needs_reconnect":
      return <Trans>Connect again to keep signing in</Trans>;
    case "connecting":
      return <Trans>Finish connecting in the other tab</Trans>;
    default:
      return <Trans>Let bots sign in with logins you approve</Trans>;
  }
}
