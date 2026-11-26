import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePageAppBridge } from "../../lib/pages/page-app-bridge";
import type { PageBlock } from "../../lib/pages/page-cards";
import { useOpenPage, usePageDocument } from "../../lib/pages/pages";
import { useSpaceQueries } from "../../lib/query/query";
import { PageFrame } from "./PageFrame";
import { PageTileIcon } from "./page-icon";

type AppCard = NonNullable<PageBlock["card"]>;
/** Past this the card scrolls inside; the whole app is one click away. */
const MAX_CARD_HEIGHT = 560;

/**
 * One of an installed app's cards a bot showed in the chat: the app drawn on that card, live, with
 * its data read through the same bridge as the open app. The footer opens the whole app.
 */
export function AppCardBlock({ block, card }: { block: PageBlock; card: AppCard }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const openPage = useOpenPage();
  const page = useQuery(queries.pages.get.queryOptions({ input: { pageId: block.pageId } }));
  const appView = useQuery(
    queries.pages.appState.queryOptions({ input: { pageId: block.pageId } }),
  );
  const app = appView.data?.app ?? null;
  // The card draws with the state it opened with; newer state reaches it through the bridge.
  const [openedWith, setOpenedWith] = useState<{
    state: Record<string, unknown>;
    revision: number;
    card: AppCard;
  } | null>(null);
  if (app && !openedWith) setOpenedWith({ state: app.state, revision: app.revision, card });
  const bridge = usePageAppBridge(block.pageId, app);
  const viewer = usePageDocument(
    appView.isPending ? undefined : page.data?.code,
    "card",
    false,
    0,
    openedWith ?? undefined,
  );
  const [height, setHeight] = useState(0);
  const title = page.data?.title ?? block.title;
  const failed = viewer.failed || (page.isError && page.data === undefined);
  return (
    <div
      data-testid="app-card"
      className="w-full max-w-[561px] overflow-hidden rounded-[24px] bg-card ring-[0.5px] ring-border pointer-coarse:min-[900px]:max-w-[639px]"
    >
      <div
        className="overflow-y-auto bg-card"
        style={{ height: Math.min(Math.max(height, 120), MAX_CARD_HEIGHT) }}
      >
        {viewer.document && !failed ? (
          <div style={{ height: height || "100%" }}>
            <PageFrame
              document={viewer.document}
              title={title}
              interactive
              app={bridge}
              onHeight={setHeight}
            />
          </div>
        ) : failed ? (
          <p className="px-6 pt-6 text-center text-body text-muted-foreground">
            <Trans>This app couldn't load</Trans>
          </p>
        ) : (
          <div className="h-full bg-foreground/[0.03] motion-safe:animate-pulse" />
        )}
      </div>
      <button
        type="button"
        onClick={() => openPage(block.pageId)}
        aria-label={t`Open ${title}`}
        className="flex h-[73px] w-full items-center gap-[14px] border-t border-foreground/[0.04] px-5 text-left outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <PageTileIcon />
        <div className="min-w-0">
          <div className="relative top-[1px] truncate text-body-lg leading-[21px] text-foreground">
            {title}
          </div>
          <div className="truncate text-body text-muted-foreground">
            <Trans>App</Trans>
          </div>
        </div>
      </button>
    </div>
  );
}
