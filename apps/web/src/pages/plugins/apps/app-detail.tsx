import { Trans, useLingui } from "@lingui/react/macro";
import type { AppInstall, AppListing } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { PluginLogo } from "../../../components/integrations/plugin-marketplace";
import { PageFrame } from "../../../components/pages/PageFrame";
import { usePageDocument } from "../../../lib/pages/pages";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails } from "../../../lib/query/user-error";
import { AppPermissionList } from "./app-permissions";

/**
 * The installed app in the page viewer's sandbox. Its code comes from the server's checked launch,
 * and the frame answers only the requests its install granted.
 */
function AppFrame({ install }: { install: AppInstall }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const launch = useQuery(queries.apps.launch.queryOptions({ input: { id: install.id } }));
  const { document, failed, retry } = usePageDocument(launch.data?.code);
  if (launch.error)
    return <ErrorNotice error={errorDetails(launch.error, t`Could not open this app`)} />;
  if (failed)
    return (
      <ErrorNotice error={errorDetails(t`Could not open this app`)}>
        <Button variant="outline" size="sm" onClick={retry}>
          <Trans>Retry</Trans>
        </Button>
      </ErrorNotice>
    );
  if (!document || !launch.data)
    return (
      <div className="grid h-120 place-items-center">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  return (
    <div
      data-testid="app-frame"
      className="h-120 overflow-hidden rounded-xl border border-border/70"
    >
      <PageFrame
        document={document}
        title={launch.data.name}
        interactive
        allow={launch.data.granted}
      />
    </div>
  );
}

/** One app: what it is and asks for, its consent to add it, and once added, opening or removing it. */
export function AppDetail({ listing, onBack }: { listing: AppListing; onBack: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const installed = useQuery(queries.apps.installed.queryOptions());
  const install = installed.data?.find((row) => row.appId === listing.appId);
  const [consenting, setConsenting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [open, setOpen] = useState(false);
  const add = useSave({
    // Consent covers exactly the version shown and everything it asks for.
    save: (shown: AppListing, rpc) =>
      rpc.apps.install({
        releaseId: shown.releaseId,
        digest: shown.digest,
        grant: shown.permissions,
      }),
    stale: [queries.apps.installed.key()],
    onSaved: () => setConsenting(false),
  });
  const remove = useSave({
    save: (id: string, rpc) => rpc.apps.uninstall({ id }),
    stale: [queries.apps.installed.key()],
    onSaved: () => {
      setConfirmRemove(false);
      setOpen(false);
    },
  });
  const busy = add.pending || remove.pending;
  const name = install?.name ?? listing.name;
  const permissions = install?.granted ?? listing.permissions;

  function headerAction() {
    if (!install)
      return (
        <Button
          size="lg"
          className="px-5"
          disabled={busy || installed.isPending}
          onClick={() => {
            add.reset();
            setConsenting(true);
          }}
        >
          <Trans>Add</Trans>
        </Button>
      );
    if (confirmRemove)
      return (
        <>
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => setConfirmRemove(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={busy}
            onClick={() => remove.run(install.id)}
          >
            {remove.pending ? <Trans>Removing…</Trans> : <Trans>Confirm removal</Trans>}
          </Button>
        </>
      );
    return (
      <>
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          onClick={() => setConfirmRemove(true)}
        >
          <Trans>Remove</Trans>
        </Button>
        <Button size="lg" className="px-5" disabled={busy} onClick={() => setOpen(!open)}>
          {open ? <Trans>Close</Trans> : <Trans>Open</Trans>}
        </Button>
      </>
    );
  }

  return (
    <div data-testid="app-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={busy}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <PluginLogo name={name} logo={install?.icon ?? listing.icon} large />
        <div className="min-w-0 flex-1 pt-3">
          <h2 className="truncate text-heading2 font-semibold text-foreground">{name}</h2>
        </div>
        <div className="flex shrink-0 gap-2 pt-2">{headerAction()}</div>
      </div>

      {remove.error ? (
        <ErrorNotice error={errorDetails(remove.error, t`Could not remove this app`)} />
      ) : null}

      {open && install ? <AppFrame install={install} /> : null}

      <p className="text-body-lg leading-6 text-muted-foreground">
        {install?.description ?? listing.description}
      </p>

      <section>
        <h3 className="mb-2 px-1 text-body font-medium text-foreground">
          <Trans>Permissions</Trans>
        </h3>
        <div className="px-1">
          <AppPermissionList permissions={permissions} />
        </div>
      </section>

      <AlertDialog open={consenting} onOpenChange={(next) => !add.pending && setConsenting(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {listing.permissions.length ? (
                <Trans>Allow {listing.name} to:</Trans>
              ) : (
                <Trans>Add {listing.name}?</Trans>
              )}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AppPermissionList permissions={listing.permissions} />
          {add.error ? (
            <ErrorNotice error={errorDetails(add.error, t`Could not add this app`)} />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={add.pending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={add.pending} onClick={() => add.run(listing)}>
              {add.pending ? (
                <Trans>Adding…</Trans>
              ) : listing.permissions.length ? (
                <Trans>Allow</Trans>
              ) : (
                <Trans>Add</Trans>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
