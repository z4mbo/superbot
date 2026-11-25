import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

for (const [platform, nativeWindowFrame, controls] of [
  ["win32", true, false],
  ["win32", false, true],
  ["linux", false, true],
  ["darwin", false, false],
] as const) {
  test(`window controls: ${platform}, native frame ${nativeWindowFrame}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      ({ platform, nativeWindowFrame }) => {
        Object.defineProperty(window, "rakazoDesktop", {
          value: {
            platform,
            nativeWindowFrame,
            window: {
              close: async () => {},
              minimize: async () => {},
              toggleMaximize: async () => {},
              state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
            },
          },
        });
      },
      { platform, nativeWindowFrame },
    );
    await page.goto("/e2e/fixtures/window-chrome.html");
    await expect(page.getByText("Window controls preview")).toBeVisible();
    for (const name of ["Minimize", "Maximize", "Close"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(controls ? 1 : 0);
    }
    if (controls) {
      // As in the reference desktop app: 12px glyphs 38px apart, centred 26px down, the last
      // 30px from the window's right edge.
      const width = page.viewportSize()!.width;
      const centres = await Promise.all(
        ["Minimize", "Maximize", "Close"].map(async (name) => {
          const box = (await page.getByRole("button", { name }).boundingBox())!;
          return { x: width - (box.x + box.width / 2), y: box.y + box.height / 2 };
        }),
      );
      expect(centres).toEqual([
        { x: 106, y: 26 },
        { x: 68, y: 26 },
        { x: 30, y: 26 },
      ]);
      // Not a drag region: there the pointer never tells the page it left a button, and the
      // button kept its hover fill as if it were plated at rest.
      const block = page.getByTestId("window-controls");
      expect(
        await block.evaluate((node) =>
          getComputedStyle(node).getPropertyValue("-webkit-app-region"),
        ),
      ).toBe("no-drag");
      const fill = (name: string) =>
        page
          .getByRole("button", { name })
          .evaluate((node) => [
            getComputedStyle(node).backgroundColor,
            getComputedStyle(node).color,
          ]);
      const clear = "rgba(0, 0, 0, 0)";
      for (const name of ["Minimize", "Maximize", "Close"])
        expect((await fill(name))[0]).toBe(clear);
      // A subtle neutral fill under minimize and maximize, red with a white glyph under close.
      for (const name of ["Minimize", "Maximize"]) {
        await page.getByRole("button", { name }).hover();
        await expect
          .poll(async () => (await fill(name))[0])
          .toMatch(/oklab\(0\.97[0-9]* .*\/ 0\.08\)/);
      }
      await page.getByRole("button", { name: "Close" }).hover();
      await expect
        .poll(async () => (await fill("Close")).join(" "))
        .toBe("rgb(207, 43, 53) rgb(255, 255, 255)");
      await page.mouse.move(600, 400);
      for (const name of ["Minimize", "Maximize", "Close"])
        await expect.poll(async () => (await fill(name))[0]).toBe(clear);
    }
    await captureScreenshot(page, testInfo, `window-chrome-${platform}-${nativeWindowFrame}`);
  });
}
