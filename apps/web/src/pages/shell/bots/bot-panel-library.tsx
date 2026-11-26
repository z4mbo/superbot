import { Trans, useLingui } from "@lingui/react/macro";
import { Spinner } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { FileCode, FileImage, FileText } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PAGES_PREVIEW_COUNT, PagesList } from "../../../components/pages/PagesList";
import { useSpaceQueries } from "../../../lib/query/query";
import { PanelCardSection } from "./bot-panel-card";

/** The bot panel's Library tab: the pages it built for you, then the files it made. */
export function BotPanelLibrary({
  bot,
  onOpenPages,
}: {
  bot: { id: string; name: string };
  /** Opens the whole page list. */
  onOpenPages: () => void;
}) {
  const { t } = useLingui();
  return (
    <div data-testid="bot-panel-library" className="flex flex-col gap-6">
      <PanelCardSection label={<Trans>Private to you</Trans>} testId="bot-panel-private">
        <PagesList botId={bot.id} preview={{ onOpenAll: onOpenPages }} />
      </PanelCardSection>
      <PanelCardSection label={t`${bot.name}’s files`} testId="bot-panel-files">
        <BotFiles key={bot.id} botId={bot.id} />
      </PanelCardSection>
    </div>
  );
}

/** Files the bot made and attached in its chats, newest first. */
function BotFiles({ botId }: { botId: string }) {
  const queries = useSpaceQueries();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const files = useInfiniteQuery(
    queries.artifacts.listSpace.infiniteOptions({
      input: (cursor: string | undefined) => ({
        botId,
        madeByBots: true,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  if (files.isPending) {
    return (
      <div className="grid place-items-center py-2.5 text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  const items = files.data?.pages.flatMap((page) => page.items) ?? [];
  if (files.isError && items.length === 0) {
    return (
      <p role="alert" className="px-3 py-2.5 text-body text-muted-foreground">
        <Trans>Couldn't load files.</Trans>
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-3 py-2.5 text-body text-muted-foreground">
        <Trans>No files yet</Trans>
      </p>
    );
  }
  const shown = showAll ? items : items.slice(0, PAGES_PREVIEW_COUNT);
  const more = showAll
    ? files.hasNextPage
    : items.length > PAGES_PREVIEW_COUNT || files.hasNextPage;
  return (
    <div>
      <ul className="flex flex-col">
        {shown.map((file) => {
          const Icon = file.mimeType.startsWith("image/")
            ? FileImage
            : file.mimeType === "text/html"
              ? FileCode
              : FileText;
          return (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => navigate(`/app/artifacts/${file.id}`)}
                className="flex w-full items-center gap-3 px-3 py-2 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
                  <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1 truncate text-body text-foreground" dir="auto">
                  {file.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more ? (
        <button
          type="button"
          disabled={files.isFetchingNextPage}
          onClick={() => {
            setShowAll(true);
            if (showAll || items.length <= PAGES_PREVIEW_COUNT) void files.fetchNextPage();
          }}
          className="w-full py-2.5 text-center text-body text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Trans>Show more</Trans>
        </button>
      ) : null}
    </div>
  );
}
