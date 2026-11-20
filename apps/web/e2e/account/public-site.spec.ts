import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("a new visitor opens the developer guide from the landing page", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome\/$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await captureScreenshot(page, testInfo, "superbot-welcome");
  await page.locator('a[href="docs/"], a[href="/welcome/docs/"]').first().click();
  await expect(page).toHaveURL(/\/welcome\/docs\/$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await captureScreenshot(page, testInfo, "superbot-developer-guide");
});
