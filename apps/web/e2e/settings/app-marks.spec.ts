import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

// Cached public catalog artwork keeps visual coverage offline and repeatable.
const catalogApps = ["gmail", "obscure-app", "notion", "github"];
test.use({ deviceScaleFactor: 3 });

async function expectLoadedLogo(logo: Locator) {
  await logo.scrollIntoViewIfNeeded();
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
}

for (const theme of ["light", "dark"]) {
  test(`opens the Store from the footer and renders catalog logos in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    for (const app of catalogApps) {
      await page.route(`https://logos.composio.dev/api/${app}`, (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: readFileSync(
            new URL(
              `../fixtures/app-marks/${app === "obscure-app" ? "notion" : app}.svg`,
              import.meta.url,
            ),
          ),
        }),
      );
    }
    await page.route("**/rpc/connections/catalog", (route) =>
      route.fulfill({
        json: {
          json: catalogApps.map((slug) => ({
            connectorId: "composio",
            slug,
            name: slug,
            connected: slug === "github",
            noAuth: false,
            logo: `https://logos.composio.dev/api/${slug}`,
          })),
        },
      }),
    );
    await signup(page, `app-marks-${theme}-${Date.now()}@rakazo.test`, "password12", "Demo User");
    await completeOnboarding(page);
    const footer = page.getByTestId("sidebar-footer");
    const store = footer.getByRole("button", { name: "Store", exact: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(store).toBeVisible();
    // Settings lives in the account menu; the footer keeps the account and the Store.
    await expect(footer.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    for (const hover of [false, true]) {
      if (hover) await store.hover();
      const name = `sidebar-footer-${theme}${hover ? "-hover" : ""}`;
      const path = testInfo.outputPath(`${name}.png`);
      await footer.screenshot({ path, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }

    await store.click();
    const dialog = page.getByRole("dialog", { name: "Store", exact: true });
    await expect(dialog).toBeVisible();
    const connected = dialog.getByRole("button", { name: "1 connected", exact: true });
    await expectLoadedLogo(connected.locator('img[src="https://logos.composio.dev/api/github"]'));
    const connectedLogo = dialog
      .getByTestId("connected-now")
      .getByRole("button", { name: "github", exact: true })
      .locator("img");
    await expect(connectedLogo).toHaveAttribute("src", "https://logos.composio.dev/api/github");
    await expectLoadedLogo(connectedLogo);
    await captureScreenshot(page, testInfo, `store-connected-app-marks-${theme}`);

    const search = dialog.getByRole("textbox", { name: "Search connections", exact: true });
    for (const app of ["gmail", "notion", "obscure-app"]) {
      await search.fill(app);
      await expectLoadedLogo(dialog.locator(`img[src="https://logos.composio.dev/api/${app}"]`));
    }

    await dialog.getByRole("button", { name: "Close store", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("@gmail");
    await page.getByRole("option", { name: "@gmail", exact: true }).click();
    await expect(page.getByTestId("mention-chip").filter({ hasText: "@gmail" })).toBeVisible();
  });
}
