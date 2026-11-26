// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centred peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        peerName="Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex min-w-0 max-w-full justify-center"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain("truncate font-medium");
    expect(html).toContain("data-bot-mark=");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
    expect(html).not.toContain("peer-replies-toggle");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Searching the web: injury news"
        announcement="Searching the web: injury news"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain('data-bot-mark-state="working"');
  });

  it("keeps the shimmering label out of the live region", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Thinking it through"
        announcement="Working…"
      />,
    );

    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Working…");
    expect(status.className).toBe("sr-only");
    const label = container.querySelector(".text-shimmer")!;
    expect(label.textContent).toBe("Thinking it through");
    expect(label.getAttribute("aria-hidden")).toBe("true");
    expect(label.closest('[role="status"]')).toBeNull();
  });
});
