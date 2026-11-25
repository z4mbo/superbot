import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not laid out");
  return found;
}

test("the working line waits right above the composer and leaves when the run ends", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `working-line-${Date.now()}@rakazo.test`, "password12", "Working Line");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible({ timeout: 30_000 });

  const line = page.getByTestId("working-indicator");
  await expect(line).toBeVisible();
  const transcript = page.getByTestId("transcript");
  const rows = transcript.locator("[data-message-id]");
  await expect(rows.last()).toBeVisible();

  // Its box sits between the last message and the composer, and no message is below it.
  const lineBox = await box(line);
  const composerBox = await box(page.getByTestId("composer-bar"));
  const lastBox = await box(rows.last());
  expect(lineBox.y).toBeGreaterThanOrEqual(lastBox.y + lastBox.height);
  expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(composerBox.y);
  // The reference's spacing: 4px under the last bubble, 14px above the composer, 36px tall.
  expect(lineBox.height).toBe(36);
  expect(composerBox.y - (lineBox.y + lineBox.height)).toBeCloseTo(14, 0);
  for (const row of await rows.all()) {
    const rowBox = await box(row);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(lineBox.y + 0.5);
  }
  // Left-aligned with the chat column.
  expect(lineBox.x).toBeCloseTo((await box(transcript.locator("[data-message-id]").first())).x, 0);

  const mark = line.locator("[data-bot-mark]");
  await expect(mark).toHaveAttribute("data-bot-mark-state", "working");
  const markBox = await box(mark);
  expect([markBox.width, markBox.height]).toEqual([28, 28]);
  const label = line.locator('[aria-hidden="true"][dir="auto"]');
  await expect(label).toHaveCSS("font-size", "14px");
  await expect(label).toHaveCSS("line-height", "22px");
  await expect(label).toHaveCSS("animation-name", "text-shimmer");
  await expect(line.getByRole("status")).toHaveText("Working…");
  await captureScreenshot(page, testInfo, "working-line-above-composer");

  // Reduced motion: the label stops sweeping and stays readable.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(label).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(line).toHaveCount(0);
});
