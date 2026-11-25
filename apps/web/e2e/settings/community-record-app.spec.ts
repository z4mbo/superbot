import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "../helpers/helpers";

test("a member installs the calorie diary, records meals and reopens the day's total", async ({
  page,
}, testInfo) => {
  await signup(page, `diary-${Date.now()}@example.test`, "password12", "Diary Test");
  const bot = await rpc<{ id: string }>(page, "bots/create", { name: "Diary keeper" });
  await page.goto(`/app/${bot.id}`);
  const openDiary = async () => {
    await page
      .getByTestId("sidebar-footer")
      .getByRole("button", { name: "Store", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Apps", exact: true }).click();
    await dialog
      .getByRole("button", { name: /Calorie diary/ })
      .first()
      .click();
    return dialog;
  };

  const detail = await openDiary();
  await detail.getByRole("button", { name: "Install", exact: true }).click();
  const openMeals = () =>
    page.getByRole("listitem", { name: "meals" }).getByRole("button", { name: "Open" }).click();
  await openMeals();
  const app = page.getByTestId("community-app");
  for (const [meal, calories] of [
    ["Pasta", "480"],
    ["Yogurt", "220"],
  ] as const) {
    await app.getByLabel("Meal", { exact: true }).fill(meal);
    await app.getByLabel("Calories (kcal)", { exact: true }).fill(calories);
    await app.getByRole("button", { name: "Add entry" }).click();
    await expect(app.getByTestId("community-app-record").filter({ hasText: meal })).toBeVisible();
  }
  await expect(app.getByTestId("community-app-total")).toContainText("700");
  await captureScreenshot(page, testInfo, "community-calorie-diary");
  await page.reload();
  await expect(page.getByTestId("store-apps")).toHaveAttribute("aria-selected", "true");
  // A link from before Plugins became Apps opens Apps too.
  await page.goto(`/app/${bot.id}?plugins`);
  await expect(page.getByTestId("store-apps")).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Calorie diary/ })
    .first()
    .click();
  await openMeals();
  await expect(app.getByTestId("community-app-record")).toHaveCount(2);
  await expect(app.getByTestId("community-app-total")).toContainText("700");
});
