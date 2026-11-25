import { useLingui } from "@lingui/react/macro";
import type { NotEmailedReason } from "@rakazo/contracts";
import {
  CopyTextFallback,
  cn,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useCopyText } from "../../lib/copy-text";

/** What an invitation by email came back with. */
export type InvitationEmailResult = {
  url: string;
  emailed?: boolean;
  notEmailedReason?: NotEmailedReason;
};

/**
 * Says whether an invitation went out by email, and why not when it did not, beside its link to
 * share by hand either way.
 */
export function InvitationEmailNotice({
  email,
  sent,
  className,
}: {
  /** The address invited. */
  email: string;
  sent: InvitationEmailResult;
  className?: string;
}) {
  const { t } = useLingui();
  const [copied, copy, failed, reset, failedText] = useCopyText();
  const status = sent.emailed
    ? t`Invitation emailed to ${email}.`
    : sent.notEmailedReason === "not_configured"
      ? t`Not emailed to ${email}: email isn't set up on this server.`
      : sent.notEmailedReason === "send_failed"
        ? t`Not emailed to ${email}: sending failed.`
        : sent.notEmailedReason === "unverified_inviter"
          ? t`Not emailed to ${email}: verify your email address first.`
          : sent.notEmailedReason === "rate_limited"
            ? t`Not emailed to ${email}: daily invitation limit reached.`
            : t`Not emailed to ${email}.`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <p
        role="status"
        className={cn("px-1 text-body-sm", sent.emailed ? "text-muted-foreground" : "text-warning")}
      >
        {status}
      </p>
      <InputGroup size="lg">
        <InputGroupInput
          readOnly
          aria-label={t`Invite link`}
          value={sent.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            aria-label={copied ? t`Copied` : t`Copy invite link`}
            onClick={() => void copy(sent.url)}
          >
            {copied ? <Check /> : <Copy />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <CopyTextFallback
        open={failed}
        onOpenChange={(open) => {
          if (!open) reset();
        }}
        text={failedText}
        label={t`Invite link`}
      />
    </div>
  );
}
