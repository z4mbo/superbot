// @vitest-environment jsdom
import type { LogoAvatarActivity } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

function stubMedia(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduced && query.includes("reduce"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

function mount(activity: LogoAvatarActivity) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: LogoAvatarActivity) =>
    act(() =>
      root.render(
        <BotAvatar
          color="#2A92FE::shape_0"
          identity="maya"
          activity={next}
          status={next === "idle" ? "idle" : "running"}
        />,
      ),
    );
  render(activity);
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { svg: () => container.querySelector("svg")!, render };
}

describe("BotAvatar motion", () => {
  it.each<[LogoAvatarActivity, string]>([
    ["idle", "idle"],
    ["working", "working"],
    ["reading", "working"],
    ["computer", "working"],
    ["thinking", "thinking"],
    ["waiting", "waiting"],
    ["error", "blocked"],
  ])("shows activity %s as the %s motion", (activity, motion) => {
    const html = renderToString(
      <BotAvatar color="#2A92FE::shape_5" identity="maya" activity={activity} />,
    );
    expect(html).toContain(`data-motion="${motion}"`);
  });

  it("falls back to the run status when no live activity is given", () => {
    const motion = (status: string) =>
      renderToString(<BotAvatar color="#2A92FE::shape_1" status={status} />).match(
        /data-motion="(\w+)"/,
      )?.[1];
    expect(motion("idle")).toBe("idle");
    expect(motion("running")).toBe("working");
    expect(motion("failed")).toBe("blocked");
  });

  it("extrudes the flat body with slices stacked behind the face", () => {
    const html = renderToString(<BotAvatar color="#2A92FE::shape_2" identity="maya" />);
    const slices = html.match(/rakazo-mascot-avatar-slice"/g) ?? [];
    expect(slices).toHaveLength(6);
    expect(html.indexOf("rakazo-mascot-avatar-depth")).toBeLessThan(
      html.indexOf("rakazo-mascot-avatar-face"),
    );
    expect(html).toMatch(/--rakazo-mascot-depth:[\d.]+px/);
    // Flat: no drop shadow or glow on the body.
    expect(html).not.toContain("drop-shadow");
  });

  it("morphs the extrusion with the organic face while working", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6" status="running" />);
    expect(html.match(/<animate /g)).toHaveLength(7);
  });

  it("plays one settling turn when work ends, and clears it when work starts again", () => {
    stubMedia(false);
    const avatar = mount("working");
    expect(avatar.svg().dataset.settling).toBe("false");
    avatar.render("idle");
    expect(avatar.svg().dataset.motion).toBe("idle");
    expect(avatar.svg().dataset.settling).toBe("true");
    avatar.render("working");
    expect(avatar.svg().dataset.settling).toBe("false");
  });

  // The turn itself is switched off in CSS under prefers-reduced-motion; the e2e spec checks it.
  it("drops the working morph under reduced motion", () => {
    stubMedia(true);
    const avatar = mount("working");
    expect(avatar.svg().dataset.motion).toBe("working");
    expect(avatar.svg().querySelector("animate")).toBeNull();
  });
});
