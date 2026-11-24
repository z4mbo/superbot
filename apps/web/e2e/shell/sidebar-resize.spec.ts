import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  rpc,
  signup,
} from "../helpers/helpers";

test("sidebar resizes by dragging, remembers its width and cannot be hidden", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `sidebar-resize-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Research",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
  await expect(sidebar).toHaveCSS("width", "280px");
  await expect(page.getByRole("button", { name: /Minimize bots|Show bots/ })).toHaveCount(0);
  await handle.hover({ position: { x: 6, y: 300 } });
  const edge = (await handle.boundingBox())!;
  await page.mouse.down();
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await page.mouse.move(edge.x + 6 + 120, edge.y + 300, { steps: 10 });
  await expect(sidebar).toHaveCSS("width", "400px");
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
  await captureScreenshot(page, testInfo, "sidebar-resized-expanded");

  // A narrow drag stops at the minimum width instead of folding the sidebar away.
  await handle.hover({ position: { x: 6, y: 300 } });
  const wide = (await handle.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(wide.x - 300, wide.y + 300, { steps: 10 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "240px");
  await expect(row.locator("[data-roster-bot-name]")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "240px");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "316px");
  await expect(sidebar.getByTestId("sidebar-search-trigger")).toBeVisible();
  await expect(row.locator("[data-roster-bot-name]")).toBeVisible();
});

test("sidebar resize follows RTL and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page, `sidebar-rtl-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  // A viewport change renders the logical sidebar side after changing document direction.
  await page.setViewportSize({ width: 1300, height: 900 });
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "312px");
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "240px");
  await handle.press("ArrowRight");
  await expect(sidebar).toHaveCSS("width", "240px");
  const box = (await sidebar.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(1300);
});

test("narrow desktop keeps the chat width when both panels are open", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signup(page, `sidebar-panels-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await handle.focus();
  await handle.press("End");
  await expect(sidebar).toHaveCSS("width", "480px");
  await openBotPanel(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveCSS("position", "absolute");
  const chat = page.locator('[data-space-switch="main"]');
  await expect(chat).toHaveCSS("width", "320px");
  await expect(panel).toHaveCSS("width", "320px");
  await captureScreenshot(page, testInfo, "sidebar-narrow-panel-overlay");
});
