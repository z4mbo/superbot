import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

for (const [control, desktop] of [
  ["bot", false],
  ["takeover", false],
  ["bot", true],
] as const) {
  for (const width of [360, 420, 480, 1280]) {
    const name = `${control}${desktop ? ", window controls" : ""}, ${width}px`;
    test(`computer overlay actions all show: ${name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 700 });
      if (desktop)
        // A Linux desktop window, whose page draws minimize, maximize and close at the top right.
        await page.addInitScript(() => {
          Object.defineProperty(window, "rakazoDesktop", {
            value: {
              platform: "linux",
              nativeWindowFrame: false,
              window: {
                close: async () => {},
                minimize: async () => {},
                toggleMaximize: async () => {},
                state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
              },
            },
          });
        });
      // No server behind the fixture: teaching finds no recording in progress.
      await page.route("**/rpc/skills/list", (route) =>
        route.fulfill({ json: { json: [] }, contentType: "application/json" }),
      );
      await page.goto(`/e2e/fixtures/computer-overlay.html?control=${control}`);
      const chrome = page.getByTestId("computer-chrome");
      const names =
        control === "bot"
          ? ["Stop", "Take control", "Teach a task", "Close computer"]
          : ["Stop", "Skip", "I’m done", "Teach a task", "Close computer"];
      const buttons = names.map((name) => chrome.getByRole("button", { name, exact: true }));
      for (const button of buttons) await expect(button).toBeVisible();
      const row = (await chrome.boundingBox())!;
      const windowControls = desktop
        ? (await page.getByTestId("window-controls").boundingBox())!
        : null;
      const boxes = await Promise.all(buttons.map(async (button) => (await button.boundingBox())!));
      for (const [index, box] of boxes.entries()) {
        // Each button sits whole inside the row and the window, its label not cut short.
        expect(box.x, names[index]).toBeGreaterThanOrEqual(row.x);
        expect(box.x + box.width, names[index]).toBeLessThanOrEqual(row.x + row.width);
        expect(box.x + box.width, names[index]).toBeLessThanOrEqual(width);
        expect(
          await buttons[index]!.evaluate((node) => node.scrollWidth <= node.clientWidth),
          names[index],
        ).toBe(true);
        // And no two overlap, nor does the window's own close sit over one.
        for (const other of [
          ...boxes.slice(index + 1),
          ...(windowControls ? [windowControls] : []),
        ]) {
          const apart =
            box.x + box.width <= other.x ||
            other.x + other.width <= box.x ||
            box.y + box.height <= other.y ||
            other.y + other.height <= box.y;
          expect(apart, names[index]).toBe(true);
        }
      }
      // The title gives way first: on a wide window everything shares one line.
      if (width === 1280) {
        const tops = new Set(boxes.map((box) => Math.round(box.y)));
        expect(tops.size).toBe(1);
      }
      await captureScreenshot(
        page,
        testInfo,
        `computer-overlay-${control}${desktop ? "-desktop" : ""}-${width}`,
      );
    });
  }
}
