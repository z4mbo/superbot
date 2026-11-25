import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

test("bot settings open the agent edit menu on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByRole("button", { name: "Edit Bot avatar" }).click();
  const studio = page.getByRole("dialog", { name: "Avatar editor" });
  await expect(studio).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Bot", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(studio.getByRole("tab", { name: "Upload", exact: true })).toBeVisible();

  // The reference's thirteen bodies (plus the bot's own when it is not one of them) and eleven
  // colours; a pick is the bot's look at once and survives a reload.
  const shapes = studio.getByRole("group", { name: "Character shape" }).getByRole("button");
  expect(await shapes.count()).toBeGreaterThanOrEqual(13);
  await expect(
    studio.getByRole("group", { name: "Character color" }).getByRole("button"),
  ).toHaveCount(11);
  const cloud = studio.getByRole("button", { name: "cloud character shape", exact: true });
  const green = studio.getByRole("button", { name: "Green character color", exact: true });
  await cloud.click();
  await green.click();
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(green).toHaveAttribute("aria-pressed", "true");
  await expect(
    settings.locator('svg[data-bot-mark="cloud"][data-bot-mark-ink="green"]').first(),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
  await page.keyboard.press("Escape");
  await expect(studio).toBeHidden();

  await page.reload();
  await openBotPanel(page);
  await page.getByTestId("bot-settings").getByRole("button", { name: "Edit Bot avatar" }).click();
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(green).toHaveAttribute("aria-pressed", "true");
  // Reset returns to the body and ink the bot's identity and colour choose.
  await studio.getByRole("button", { name: "Reset character to default", exact: true }).click();
  await expect(
    page
      .getByTestId("bot-settings")
      .locator('svg[data-bot-mark="cloud"][data-bot-mark-ink="green"]'),
  ).toHaveCount(0);
});
