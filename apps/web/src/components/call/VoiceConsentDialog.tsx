import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceConsentRequest } from "../../lib/calls/voice-consent";
import { ConfirmDialog } from "../ConfirmDialog";

export function VoiceConsentDialog({ request }: { request: VoiceConsentRequest }) {
  const { t } = useLingui();
  const name = request.recipient.name;
  const privacyUrl = request.recipient.privacyUrl ?? request.privacyUrl;
  return (
    <ConfirmDialog
      title={t`Share voice data with ${name}?`}
      description={
        <>
          {request.recipient.detail ? (
            <span className="mb-2 block break-words">{request.recipient.detail}</span>
          ) : null}
          <Trans>
            Your recordings are sent for transcription, and text you play is sent to generate
            speech.
          </Trans>
        </>
      }
      confirmLabel={t`Allow`}
      variant="default"
      onConfirm={() => request.finish(true)}
      onCancel={() => request.finish(false)}
    >
      {privacyUrl ? (
        <a
          className="text-body text-muted-foreground underline underline-offset-4"
          href={privacyUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans>Privacy policy</Trans>
        </a>
      ) : null}
    </ConfirmDialog>
  );
}
