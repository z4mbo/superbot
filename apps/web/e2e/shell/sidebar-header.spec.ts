import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("the sidebar header offers search and create, and the roster always shows", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `sidebar-header-${stamp}@rakazo.test`, "password12", "Sidebar Header");
  await completeOnboarding(page);
  // An older version kept a run list in place of the roster; its stored choice changes nothing.
  await page.evaluate(() => localStorage.setItem("rakazo.activity-mode", "1"));
  await page.reload();

  const aside = page.locator("aside").first();
  await expect(aside.locator("[data-sidebar-group]").getByText("Chief").first()).toBeVisible();
  await aside.getByTestId("create-menu-trigger").hover();
  await expect(aside.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(aside.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(aside.getByText("Working", { exact: true })).toHaveCount(0);
  await expect(aside.getByText("Recent", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-header-hover");
});
