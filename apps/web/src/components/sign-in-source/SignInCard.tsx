import { Trans, useLingui } from "@lingui/react/macro";
import type { SignInBlock } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { KeyRound } from "lucide-react";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";
import { openSignInLink } from "./open-sign-in-link";

function siteHost(site: string): string {
  return URL.canParse(site) ? new URL(site).host : site;
}

/**
 * A bot asking to sign in to a site with a login from the person's password manager. The person
 * reviews the request in the password manager's own app; the card follows the request from the
 * stored message, so it shows the same after a reload.
 */
export function SignInCard({ block, canAct }: { block: SignInBlock; canAct: boolean }) {
  const { t } = useLingui();
  const label = block.label;
  const host = siteHost(block.site);
  // The approval link is read only when the person asks for it, and opened exactly as returned.
  const review = useSave({
    save: (requestId: string, rpc) => rpc.signInSource.review({ requestId }),
    onSaved: ({ approvalLink }) => openSignInLink(approvalLink),
  });
  const connect = useSave({
    save: (_: void, rpc) => rpc.signInSource.connect(),
    onSaved: ({ authorizeUrl }) => openSignInLink(authorizeUrl),
  });
  const error = review.error
    ? errorText(review.error, t`Couldn't open the request`)
    : connect.error
      ? errorText(connect.error, t`Couldn't connect ${label}`)
      : null;
  // The desktop app hands only web links to the system, so an app link can't open from it.
  const desktop = Boolean(desktopBridge());
  const outcome =
    block.status === "approved"
      ? t`Approved`
      : block.status === "denied"
        ? t`Declined`
        : block.status === "expired"
          ? t`Expired`
          : block.status === "failed"
            ? t`Couldn't finish`
            : null;
  const action =
    !canAct || outcome ? null : block.status === "needs_connection" ? (
      <Button size="sm" disabled={connect.pending} onClick={() => connect.run()}>
        <Trans>Connect {label}</Trans>
      </Button>
    ) : block.requestId && !desktop ? (
      <Button
        size="sm"
        disabled={review.pending}
        onClick={() => block.requestId && review.run(block.requestId)}
      >
        <Trans>Review in {label}</Trans>
      </Button>
    ) : block.requestId ? (
      <span className="text-body-sm text-muted-foreground">
        <Trans>Review on your phone or in a browser</Trans>
      </span>
    ) : null;
  return (
    <BuiCard
      role="group"
      aria-label={t`Sign in to ${host}`}
      data-testid="sign-in-card"
      data-status={block.status}
      className="w-full max-w-[440px] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted text-foreground">
          <KeyRound aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium text-foreground">{host}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {outcome ??
              (block.status === "needs_connection"
                ? t`No password manager connected`
                : t`Sign in with ${label}`)}
          </span>
        </span>
        {action}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-label text-destructive">
          {error}
        </p>
      ) : null}
    </BuiCard>
  );
}
