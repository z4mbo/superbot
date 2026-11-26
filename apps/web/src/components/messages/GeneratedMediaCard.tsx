import { useLingui } from "@lingui/react/macro";
import type { GeneratedMediaInfo, MessageBlock } from "@rakazo/contracts";
import { CircleAlert } from "lucide-react";
import { BuiCard, LoadingState } from "../ai/primitives";

type MediaGenerationBlock = Extract<MessageBlock, { kind: "media_generation" }>;

/** What made a generated image or video: its prompt, then the provider and model. */
export function GeneratedMediaDetails({ media }: { media: GeneratedMediaInfo }) {
  return (
    <div className="px-4 py-3" data-testid="generated-media-details">
      <p dir="auto" className="line-clamp-3 text-body-sm text-foreground">
        {media.prompt}
      </p>
      <p className="mt-0.5 flex min-w-0 gap-2 text-body-sm text-muted-foreground">
        <span className="shrink-0">{media.providerName}</span>
        {media.model ? <span className="min-w-0 truncate">{media.model}</span> : null}
      </p>
    </div>
  );
}

/**
 * A video being made, or one that could not be. A finished one arrives as its own message, so
 * nothing draws this card once it completes.
 */
export function MediaGenerationCard({
  block,
  startedAt,
}: {
  block: MediaGenerationBlock;
  /** When the job was accepted, for the elapsed time. */
  startedAt?: number;
}) {
  const { t } = useLingui();
  if (block.status === "completed") return null;
  return (
    <BuiCard className="w-[320px] max-w-full overflow-hidden" data-testid="media-generation-card">
      <div className="px-4 pt-3.5">
        {block.status === "failed" ? (
          <p role="alert" className="flex items-center gap-2 text-body font-medium text-foreground">
            <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
            {t`Couldn't make the video`}
          </p>
        ) : (
          <LoadingState label={t`Making the video`} startedAt={startedAt} />
        )}
      </div>
      <GeneratedMediaDetails media={block.media} />
    </BuiCard>
  );
}
