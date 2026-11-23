import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

const example = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/team-dashboard",
);
const manifest = JSON.parse(readFileSync(path.join(example, "app.json"), "utf8"));
const source = readFileSync(path.join(example, "src/app.jsx"), "utf8").replace(/\r\n/g, "\n");

/** The app document, two sandboxed frames down. */
function appFrame(page: Page, title: string) {
  return page
    .locator(`iframe[title="${title}"]`)
    .last()
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /^Message/ }).last();
  await composer.fill(text);
  await composer.press("Enter");
}

test("a person and a bot use the same app, and each sees the other's change", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `apps-${Date.now()}@rakazo.test`, "password12", "App Reader");
  await completeOnboarding(page);
  const title = "Team dashboard";
  const { entry: _entry, ...app } = manifest;
  await send(page, `call save_page with ${JSON.stringify({ title, source, app })}\nthen say Done.`);
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();
  const pageId = new URL(page.url()).searchParams.get("page");
  expect(pageId).toBeTruthy();

  // The person adds a task and records a shipped change with the app's own controls.
  const frame = appFrame(page, title);
  await expect(frame.getByText("Draft the launch notes")).toBeVisible({ timeout: 30_000 });
  await frame.getByRole("textbox", { name: "Task" }).fill("Write the release notes");
  await frame.getByRole("textbox", { name: "Owner" }).fill("Alex");
  await frame.getByRole("button", { name: "Add task" }).click();
  await expect(frame.getByText("Write the release notes")).toBeVisible();
  await frame.getByRole("button", { name: "Shipped one" }).click();
  await expect(frame.locator(".rk-metric").filter({ hasText: "Shipped" })).toContainText("1");
  await captureScreenshot(page, testInfo, "app-person-actions");

  // The bot reads the app and runs one of its actions; the open app follows without reloading.
  await send(
    page,
    `call run_app_action with ${JSON.stringify({ pageId, action: "setStatus", input: { status: "At risk" } })}\nthen say I marked the team At risk.`,
  );
  await expect(frame.locator(".rk-status").filter({ hasText: "At risk" }).first()).toBeVisible({
    timeout: 30_000,
  });
  // What the person typed is still there: the document was not replaced.
  await expect(frame.getByText("Write the release notes")).toBeVisible();
  await captureScreenshot(page, testInfo, "app-bot-action");

  // The state survives closing and opening the app again.
  await page.goto(`${new URL(page.url()).pathname}?page=${pageId}`);
  const reopened = appFrame(page, title);
  await expect(reopened.getByText("Write the release notes")).toBeVisible({ timeout: 30_000 });
  await expect(reopened.locator(".rk-status").filter({ hasText: "At risk" }).first()).toBeVisible();
});

test("an app that keeps bots out refuses the bot's action", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `apps-private-${Date.now()}@rakazo.test`, "password12", "App Owner");
  await completeOnboarding(page);
  const title = "Private dashboard";
  const { entry: _entry, ...app } = manifest;
  await send(
    page,
    `call save_page with ${JSON.stringify({ title, source, app: { ...app, permissions: ["state"] } })}\nthen say Done.`,
  );
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();
  const pageId = new URL(page.url()).searchParams.get("page");
  const frame = appFrame(page, title);
  await expect(frame.getByText("Draft the launch notes")).toBeVisible({ timeout: 30_000 });
  await send(
    page,
    `call run_app_action with ${JSON.stringify({ pageId, action: "setStatus", input: { status: "Blocked" } })}\nthen say Tried.`,
  );
  await expect(page.getByText("Tried.").last()).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator(".rk-status").filter({ hasText: "On track" }).first()).toBeVisible();
  await expect(frame.locator(".rk-status").filter({ hasText: "Blocked" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "app-bot-refused");
});
