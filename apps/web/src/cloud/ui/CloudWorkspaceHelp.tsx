import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useCopyText } from "../../lib/copy-text";
import { useCloudAccounts } from "../accounts/cloud-accounts-context";
import type { WorkspaceStatus } from "../workspaces/workspace-status";

/** What to change, for a workspace that cannot be used: shared by its row and its full page. */
export function CloudWorkspaceHelp({ status }: { status: WorkspaceStatus }) {
  const { t } = useLingui();
  const accounts = useCloudAccounts();
  const account = accounts.useAccount();
  const email = (account.status === "signed-in" ? account.user.email : null) ?? t`<your email>`;
  const origin = window.location.origin;
  const restart = <Trans>Add to this server's environment, then restart it:</Trans>;

  switch (status.state) {
    case "offline":
      return (
        <HelpText>
          <Trans>
            The server isn't answering from this device. If it's on a private network, such as a
            tailnet, this device needs to be on it too.
          </Trans>
        </HelpText>
      );
    case "not-enabled":
      return (
        <div className="space-y-2">
          <HelpText>{restart}</HelpText>
          <EnvBlock
            lines={[
              `SUPERBOT_CLOUD_WEB_ORIGINS=${origin}`,
              `SUPERBOT_CLOUD_ISSUER=${accounts.issuer}`,
              `SUPERBOT_CLOUD_ALLOWED_EMAILS=${email}`,
            ]}
          />
          <HelpText>
            <Trans>The address may also not be a Superbot server.</Trans>
          </HelpText>
        </div>
      );
    case "unauthorized":
      switch (status.reason) {
        case "account_not_allowed":
          return (
            <div className="space-y-2">
              <HelpText>{restart}</HelpText>
              <EnvBlock lines={[`SUPERBOT_CLOUD_ALLOWED_EMAILS=${email}`]} />
            </div>
          );
        case "no_local_account":
          return (
            <div className="space-y-2">
              <HelpText>
                <Trans>
                  No account on this server has this email. Name yours, then restart the server:
                </Trans>
              </HelpText>
              <EnvBlock
                lines={[`SUPERBOT_CLOUD_ALLOWED_EMAILS=${email}=${t`<your email on this server>`}`]}
              />
            </div>
          );
        case "email_unverified":
          return (
            <HelpText>
              <Trans>Verify this account's email, then try again.</Trans>
            </HelpText>
          );
        default:
          return (
            <div className="space-y-2">
              <HelpText>
                <Trans>Check these values in the server's environment, then restart it:</Trans>
              </HelpText>
              <EnvBlock
                lines={[
                  `SUPERBOT_CLOUD_ISSUER=${accounts.issuer}`,
                  `SUPERBOT_CLOUD_WEB_ORIGINS=${origin}`,
                ]}
              />
            </div>
          );
      }
    case "incompatible":
      return (
        <HelpText>
          <Trans>
            The server runs version {status.version}, which doesn't work with this page. Update the
            server, or reload this page if the server is newer.
          </Trans>
        </HelpText>
      );
    default:
      return null;
  }
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm text-muted-foreground">{children}</p>;
}

/** Environment lines to paste, with one copy for all of them. */
function EnvBlock({ lines }: { lines: string[] }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  const text = lines.join("\n");
  return (
    <div className="flex items-start gap-1 rounded-lg bg-muted py-1 ps-3 pe-1">
      <pre
        data-testid="cloud-workspace-env"
        className="min-w-0 flex-1 py-1 font-mono text-label whitespace-pre-wrap break-all text-foreground/80"
      >
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? t`Copied` : t`Copy`}
        className="text-muted-foreground"
        onClick={() => void copy(text)}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
