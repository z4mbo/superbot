import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not laid out");
  return found;
}

function bubble(page: Page, id: string) {
  return page
    .locator(`[data-message-id="${id}"]`)
    .locator('[data-testid="message-bot-bubble"], [data-testid="message-user-bubble"]');
}

const lightHairline =
  "rgba(255, 255, 255, 0.16) 0px 0.5px 0px 0px inset, rgba(255, 255, 255, 0.16) 0px -0.5px 0px 0px inset, rgba(34, 34, 34, 0.06) 0px 0px 0px 0.5px inset";
const darkHairline =
  "rgba(255, 255, 255, 0.03) 0px 0.5px 0px 0px inset, rgba(255, 255, 255, 0.03) 0px -0.5px 0px 0px inset, rgba(255, 255, 255, 0.04) 0px 0px 0px 0.5px inset";

test("bubbles draw a shadow hairline, grouped corners and chat type", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const theme of ["light", "dark"] as const) {
    await page.goto("/e2e/fixtures/chat-bubbles.html");
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(bubble(page, "m14")).toBeVisible();

    for (const id of ["m1", "m2", "m14", "m13"]) {
      const target = bubble(page, id);
      // A fill and a hairline made of shadows: no stroke at all.
      await expect(target).toHaveCSS("border-top-width", "0px");
      await expect(target).toHaveCSS("border-left-width", "0px");
      const shadow = await target.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(shadow.endsWith(theme === "light" ? lightHairline : darkHairline)).toBe(true);
      await expect(target).toHaveCSS("padding", "7px 12px");
      await expect(target).toHaveCSS("font-size", "15px");
      await expect(target).toHaveCSS("line-height", "22px");
      await expect(target).toHaveCSS("letter-spacing", "0.15px");
      // Transcript text uses the app's own sans stack, so a theme's face reaches it.
      const fonts = await target.evaluate((element) => [
        getComputedStyle(element).fontFamily,
        getComputedStyle(document.body).fontFamily,
      ]);
      expect(fonts[0]).toBe(fonts[1]);
    }
    await expect(bubble(page, "m14")).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(28, 28, 28)" : "rgba(244, 244, 244, 0.18)",
    );
    await expect(bubble(page, "m13")).toHaveCSS(
      "background-color",
      theme === "light" ? "rgba(34, 34, 34, 0.06)" : "rgba(255, 255, 255, 0.04)",
    );
    await captureScreenshot(page, testInfo, `chat-bubbles-${theme}`);
  }

  // Corners by place in a run (top-left, top-right, bottom-right, bottom-left).
  const radii: Record<string, string> = {
    m5: "18px", // a lone bot bubble
    m9: "18px 18px 18px 6px", // first of a bot run
    m10: "6px 18px 18px 6px", // middle
    m11: "6px 18px 18px", // last
    m4: "18px", // a lone bubble of yours
    m6: "18px 18px 6px", // first of your run
    m7: "18px 6px 6px 18px", // middle
    m8: "18px 6px 18px 18px", // last
  };
  for (const [id, radius] of Object.entries(radii)) {
    await expect(bubble(page, id)).toHaveCSS("border-radius", radius);
  }

  // 4px between bubbles in a run, 16px between senders.
  const gap = async (above: string, below: string) =>
    (await box(bubble(page, below))).y -
    ((await box(bubble(page, above))).y + (await box(bubble(page, above))).height);
  expect(await gap("m9", "m10")).toBeCloseTo(4, 0);
  expect(await gap("m6", "m7")).toBeCloseTo(4, 0);
  expect(await gap("m11", "m12")).toBeCloseTo(16, 0);
});

test("a held run parks the working line at the bottom while you read back", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/e2e/fixtures/chat-bubbles.html?running=1");
  const line = page.getByTestId("working-indicator");
  const transcript = page.getByTestId("transcript");
  await expect(line).toBeVisible();
  const atEnd = await box(line);
  const last = await box(bubble(page, "m14"));
  expect(atEnd.y - (last.y + last.height)).toBeCloseTo(4, 0);
  const bottom = await box(transcript);
  // The 28px under it is the strip the composer overlaps in the app; 14px more is the gap above it.
  expect(bottom.y + bottom.height - (atEnd.y + atEnd.height)).toBeCloseTo(28 + 14, 0);

  await transcript.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const parked = await box(line);
  expect(parked.y).toBeCloseTo(atEnd.y, 0);
  // The jump button clears the parked line.
  const jump = await box(page.getByRole("button", { name: "Jump to latest" }));
  expect(jump.y + jump.height).toBeLessThanOrEqual(parked.y);
  await captureScreenshot(page, testInfo, "working-line-parked");
});

test("in a right-to-left layout the working line starts at the right", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/e2e/fixtures/chat-bubbles.html?running=1");
  const line = page.getByTestId("working-indicator");
  await expect(line).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  const column = await box(bubble(page, "m13"));
  const mark = await box(line.locator("[data-bot-mark]"));
  const label = await box(line.locator('[aria-hidden="true"][dir="auto"]'));
  // Inline start: the mark sits 8px in from the column's right edge, the label to its left.
  expect(column.x + column.width - (mark.x + mark.width)).toBeCloseTo(8, 0);
  expect(label.x + label.width).toBeLessThanOrEqual(mark.x);
  // Corners mirror with the sides: a bot run's first bubble cuts its bottom-right corner.
  await expect(bubble(page, "m9")).toHaveCSS("border-radius", "18px 18px 6px");
});
