import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

/** An app's document inside its viewer shell, two sandboxed frames down. */
function appDocument(within: Locator): FrameLocator {
  return within
    .locator('iframe[title="Food Diary"]')
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /^Message/ }).last();
  await composer.fill(text);
  await composer.press("Enter");
}

test("Food Diary installs from the Store, keeps what the bot logs and shows the day in chat", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `food-diary-${Date.now()}@rakazo.test`, "password12", "Diary Keeper");
  await completeOnboarding(page);

  // Food Diary ships with the deployment, so the Store lists it without a review.
  const store = page
    .getByTestId("sidebar-footer")
    .getByRole("button", { name: "Store", exact: true });
  await store.click();
  const dialog = page.getByRole("dialog", { name: "Store", exact: true });
  await dialog.getByTestId("store-apps").click();
  const section = dialog.getByTestId("app-section");
  await section.getByRole("button", { name: "Add Food Diary", exact: true }).click();
  const detail = dialog.getByTestId("app-detail");
  await expect(detail.getByText("Keep its own records", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Add", exact: true }).click();
  const consent = page.getByRole("alertdialog", { name: "Allow Food Diary to:" });
  await expect(consent.getByText("Let bots use its actions", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "food-diary-consent");
  await consent.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // The bot logs food through the app's action, then shows the day's card in the chat.
  const entry = {
    food: "Greek yogurt",
    grams: 150,
    meal: "snack",
    kcal: 146,
    protein: 15,
    carbs: 6,
    fat: 6,
  };
  await send(
    page,
    `call run_app_action with ${JSON.stringify({ app_id: "food-diary", action: "addEntry", input: entry })}\nthen say Logged the yogurt.`,
  );
  await expect(page.getByText("Logged the yogurt.").last()).toBeVisible({ timeout: 30_000 });
  await send(
    page,
    `call open_app with ${JSON.stringify({ app_id: "food-diary", card: "day" })}\nthen say Here is today.`,
  );
  const card = page.getByTestId("app-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  const shown = appDocument(card);
  await expect(shown.getByText("Greek yogurt", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(shown.locator(".rk-metric").filter({ hasText: "Calories" })).toContainText("146");
  await captureScreenshot(page, testInfo, "food-diary-chat-card");

  // The whole app opens from the card; the person adds food with its form and the card follows.
  await card.getByRole("button", { name: "Open Food Diary", exact: true }).click();
  const app = appDocument(page.getByTestId("page-view"));
  await expect(app.getByText("Greek yogurt", { exact: true })).toBeVisible({ timeout: 30_000 });
  await app.getByRole("textbox", { name: "Food", exact: true }).fill("Banana");
  await app.getByRole("spinbutton", { name: "Grams", exact: true }).fill("120");
  await app.getByRole("spinbutton", { name: "Calories (kcal)", exact: true }).fill("107");
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await expect(app.getByText("Banana", { exact: true })).toBeVisible();
  await expect(app.locator(".rk-metric").filter({ hasText: "Calories" })).toContainText("253");
  await captureScreenshot(page, testInfo, "food-diary-app");
});
