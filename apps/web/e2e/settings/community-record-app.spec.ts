import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "../helpers/helpers";

test("a member installs the calorie diary, records meals and reopens the day's total", async ({
  page,
}, testInfo) => {
  await signup(page, `diary-${Date.now()}@example.test`, "password12", "Diary Test");
  const bot = await rpc<{ id: string }>(page, "bots/create", { name: "Diary keeper" });
  await page.goto(`/app/${bot.id}`);
  const openDiary = async () => {
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Connect apps", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Search apps" }).fill("Calorie diary");
    await dialog.getByTestId("community-picks").getByText("Calorie diary", { exact: true }).click();
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
  await openDiary();
  await openMeals();
  await expect(app.getByTestId("community-app-record")).toHaveCount(2);
  await expect(app.getByTestId("community-app-total")).toContainText("700");
});
