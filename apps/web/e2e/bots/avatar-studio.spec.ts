import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

test("bot settings open Avatar Studio on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();

  // Every mark shape and ink; a pick is the bot's look and survives a reload.
  await expect(studio.getByTestId("avatar-studio-shapes").getByRole("button")).toHaveCount(26);
  await expect(studio.getByTestId("avatar-studio-inks").getByRole("button")).toHaveCount(10);
  const cloud = studio.getByRole("button", { name: "cloud", exact: true });
  const green = studio.getByRole("button", { name: "green", exact: true });
  await cloud.click();
  await green.click();
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(green).toHaveAttribute("aria-pressed", "true");
  await expect(
    studio.locator('svg[data-bot-mark="cloud"][data-bot-mark-ink="green"]').first(),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
  await studio.getByRole("button", { name: "Done", exact: true }).click();

  await page.reload();
  await openBotPanel(page);
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(green).toHaveAttribute("aria-pressed", "true");
  // Reset returns to the shape and ink the bot's identity and colour choose.
  await studio.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(studio.locator('svg[data-bot-mark="cloud"][data-bot-mark-ink="green"]')).toHaveCount(
    0,
  );
});
