import { useExternalLinkOpener } from "@rakazo/chat-ui/web";
import { pageCopyRequest, pageCopyResult, pageLinkRequest } from "@rakazo/core";
import type { CSSProperties } from "react";
import { useCallback, useRef, useState } from "react";
import { writeClipboard } from "../../lib/copy-text";
import type { PageAppBridge } from "../../lib/pages/page-app-bridge";
import { appAllows } from "../../lib/pages/page-app-bridge";
import { pageFrameHeight } from "../../lib/pages/page-cards";
import { SandboxedHtmlViewer } from "../messages/SandboxedHtmlViewer";

/**
 * A page document in the sandboxed viewer. Only an `interactive` frame acts for its page (copy,
 * open a link, offer a reply), and only right after the person used that frame: the viewer
 * shell vouches for a click or key inside it, the frame still has focus, and that click or key
 * has not been used for another action yet. Previews draw only. An app page acts only as its
 * manifest declares, through `app`.
 * An interactive frame prints whole: on paper it keeps the width the page was drawn at, so the
 * page's last reported height still fits it, and the browser scales it to the paper.
 */
export function PageFrame({
  document,
  title,
  interactive = false,
  onHeight,
  onReply,
  app,
}: {
  document: string;
  title: string;
  interactive?: boolean;
  onHeight?: (height: number) => void;
  /** Where a page's reply button puts its text; without it the page offers no replies. */
  onReply?: (text: unknown) => void;
  /** The open app's bridge, when the page is an app. */
  app?: PageAppBridge;
}) {
  const { open, dialog } = useExternalLinkOpener();
  const box = useRef<HTMLDivElement>(null);
  const [drawnAt, setDrawnAt] = useState<CSSProperties | undefined>(undefined);
  const usedGesture = useRef<string | null>(null);
  const receive = useCallback(
    (data: unknown, answer: (message: object) => void, focused: boolean) => {
      if (!data || typeof data !== "object") return;
      const message = data as {
        type?: unknown;
        height?: unknown;
        text?: unknown;
        gesture?: unknown;
      };
      if (message.type === "rakazo-page:height" && typeof message.height === "number") {
        const height = pageFrameHeight(message.height);
        if (interactive && box.current) {
          setDrawnAt({
            "--page-width": `${box.current.offsetWidth}px`,
            "--page-height": `${height}px`,
          } as CSSProperties);
        }
        onHeight?.(height);
        return;
      }
      const { gesture } = message;
      const fresh =
        interactive && focused && typeof gesture === "string" && gesture !== usedGesture.current;
      const use = () => {
        usedGesture.current = gesture as string;
      };
      if (app?.receive(data, answer, { fresh, use })) return;
      if (!fresh) return;
      const copy = appAllows(app, "clipboard") ? pageCopyRequest(data) : null;
      const url = copy || !appAllows(app, "links") ? null : pageLinkRequest(data);
      const reply =
        !copy && !url && message.type === "rakazo-page:reply" && appAllows(app, "reply") && onReply;
      if (!copy && !url && !reply) return;
      use();
      if (copy) void writeClipboard(copy.text).then((ok) => answer(pageCopyResult(copy.id, ok)));
      else if (url) open(url);
      else if (reply) reply(message.text);
    },
    [interactive, onHeight, onReply, open, app],
  );
  return (
    <>
      <div
        ref={box}
        style={drawnAt}
        className={`h-full ${interactive ? "print:mx-auto print:h-(--page-height) print:w-(--page-width)" : ""}`}
      >
        <SandboxedHtmlViewer
          html={document}
          title={title}
          className="bg-transparent"
          onFrameMessage={receive}
        />
      </div>
      {dialog}
    </>
  );
}
