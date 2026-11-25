import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GroupAvatar } from "./group-avatar.js";

describe("GroupAvatar", () => {
  it("renders fallback squad icon when no members provided", () => {
    const html = renderToString(<GroupAvatar members={[]} />);
    expect(html).toContain("<svg");
  });

  it("renders single BotAvatar when 1 member", () => {
    const html = renderToString(<GroupAvatar members={[{ name: "Harry", color: "#8B5CF6" }]} />);
    expect(html).toContain("data-bot-mark=");
  });

  it("renders 2 overlapping bot avatars for 2 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
        ]}
      />,
    );
    const count = (html.match(/data-bot-mark-state=/g) || []).length;
    expect(count).toBe(2);
    expect(html).toContain('data-bot-mark-state="idle"');
  });

  it("renders a working member inside a group avatar", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6", status: "running" },
          { name: "Elon", color: "#06B6D4", status: "idle" },
        ]}
      />,
    );
    expect(html).toContain('data-bot-mark-state="working"');
    expect(html).toContain("data-bot-mark=");
  });

  it("renders 3 mini bot avatars for 3 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
          { name: "Penny", color: "#EC4899" },
        ]}
      />,
    );
    const count = (html.match(/data-bot-mark-state=/g) || []).length;
    expect(count).toBe(3);
  });

  it("shows the first four members and no count, with no shadow behind them", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
          { name: "Penny", color: "#EC4899" },
          { name: "Harry", color: "#10B981" },
          { name: "Ada", color: "#3B82F6" },
        ]}
      />,
    );
    expect((html.match(/data-bot-mark-state=/g) || []).length).toBe(4);
    expect(html).not.toMatch(/>\+\d/);
    expect(html).not.toContain("drop-shadow");
  });

  it("cuts a gap in a member where the next one overlaps it", () => {
    const html = renderToString(
      <GroupAvatar
        size={36}
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
        ]}
      />,
    );
    // The first member carries the mask; the one on top is whole.
    expect((html.match(/[;"]mask-image:url/g) || []).length).toBe(1);
  });
});
