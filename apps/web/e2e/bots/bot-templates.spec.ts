import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { BOT_TEMPLATES } from "@rakazo/core";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

test("a bot template previews what it adds, then creates a bot with a paused routine", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `templates-${Date.now()}@rakazo.test`, "password12", "Template Test");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Store", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Store", exact: true });
  await dialog.getByTestId("store-agents").click();
  const cards = dialog.getByTestId("bot-template-card");
  // The Store lists the server's catalog a page at a time, and search reaches all of it.
  await expect(cards.first()).toBeVisible();
  const last = BOT_TEMPLATES.at(-1)!;
  await dialog.getByRole("textbox", { name: "Search agents" }).fill(last.name);
  await expect(dialog.getByRole("button", { name: last.name, exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search agents" }).fill("");
  const briefing = dialog.getByRole("button", { name: "Morning briefing", exact: true });
  await expect(briefing).toHaveAccessibleDescription("Your day at a glance, every weekday morning");
  await expect(briefing.getByText("Needs you", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-templates");

  await briefing.click();
  const detail = dialog.getByTestId("bot-template-detail");
  await expect(detail.getByRole("heading", { name: "Morning briefing" })).toBeVisible();
  await expect(detail.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(detail.getByText("Skill", { exact: true })).toBeVisible();
  await expect(detail.getByText(/paused until you turn it on$/)).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-template-detail");

  await detail.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/[^/?]+/);
  const botId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("import-setup-card")).toBeVisible();
  await expect(page.getByTestId("import-setup-card")).toContainText("Morning briefing");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines.map((routine) => [routine.name, routine.active])).toEqual([
    ["Morning briefing", false],
  ]);
  await captureScreenshot(page, testInfo, "bot-template-created");

  // Opening the template again offers the bot it made instead of a second one.
  await page.goto(`/app/${botId}?templates`);
  await dialog.getByRole("button", { name: "Morning briefing", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Open", exact: true })).toBeVisible();
});
