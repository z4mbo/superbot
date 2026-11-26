import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

// Geometry and colours measured on the desktop reference at 1280x800, DPR 1, light theme.
test.use({ viewport: { width: 1280, height: 800 } });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not laid out");
  return found;
}

async function lightTheme(page: Page) {
  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible();
}

test("sidebar buttons, palette, account menu and tooltips follow the reference", async ({
  page,
}, testInfo) => {
  await signup(page, `surfaces-${Date.now()}@rakazo.test`, "password12", "Surface Check");
  await completeOnboarding(page);
  await lightTheme(page);

  for (const id of ["sidebar-search-trigger", "create-menu-trigger"]) {
    const found = await box(page.getByTestId(id));
    expect([found.width, found.height]).toEqual([36, 36]);
  }

  // Tooltips are a light chip with a hairline, not an inverted label with an arrow.
  await page.getByTestId("sidebar-search-trigger").hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toHaveText("Search");
  await expect(tooltip).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(tooltip).toHaveCSS("color", "rgb(28, 28, 28)");
  await expect(tooltip).toHaveCSS("border-radius", "8px");

  // A keyboard focus ring: 2px of the ring colour, a pixel outside the control.
  await page.mouse.move(640, 400);
  await page.keyboard.press("Escape");
  // Tabbing back onto the control, so the browser treats the focus as keyboard focus.
  await page.getByTestId("sidebar-search-trigger").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("sidebar-search-trigger")).toBeFocused();
  // The button transitions its shadow, so wait for the ring to settle.
  await expect
    .poll(() =>
      page
        .getByTestId("sidebar-search-trigger")
        .evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain("rgb(252, 252, 252) 0px 0px 0px 1px, rgb(30, 134, 252) 0px 0px 0px 3px");
  await page.getByTestId("sidebar-search-trigger").blur();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator('[data-slot="dialog-content"]').filter({
    has: page.getByTestId("command-palette"),
  });
  await expect(palette).toBeVisible();
  // It zooms in as it opens; measure once it has settled.
  await expect
    .poll(async () => {
      const found = await box(palette);
      return [found.width, found.y];
    })
    .toEqual([640, 120]);
  await expect(palette).toHaveCSS("border-radius", "18px");
  await expect(page.getByTestId("command-palette-search")).toHaveCSS("font-size", "20px");
  // The search is the palette's first line, with no field drawn around it.
  const searchField = palette.locator('[data-slot="input-group"]');
  await expect(searchField).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(searchField).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const firstBot = page.getByTestId("command-palette-list").locator("[cmdk-item]").first();
  await expect(firstBot.locator(":scope > *").first()).toHaveCSS("width", "28px");
  // 8px above and below a two-line row makes the reference's 56px.
  await expect(firstBot).toHaveCSS("padding-top", "8px");
  await captureScreenshot(page, testInfo, "reference-palette");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]').filter({
    has: page.getByTestId("account-menu-header"),
  });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("border-radius", "16px");
  await expect(menu).toHaveCSS("padding-top", "6px");
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toHaveCSS(
    "height",
    "32px",
  );
  await captureScreenshot(page, testInfo, "reference-account-menu");
});

test("the details panel sits on the window ground at the reference width", async ({
  page,
}, testInfo) => {
  await signup(page, `panel-ground-${Date.now()}@rakazo.test`, "password12", "Panel Ground");
  await completeOnboarding(page);
  await lightTheme(page);
  await openBotPanel(page);

  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveCSS("width", "320px");
  await expect(panel).toHaveCSS("background-color", "rgb(252, 252, 252)");
  await expect(panel).toHaveCSS("border-left-color", "rgba(26, 26, 26, 0.08)");
  for (const name of ["Bot settings", "Close panel"]) {
    const found = await box(panel.getByRole("button", { name, exact: true }));
    expect([found.width, found.height]).toEqual([36, 36]);
  }
  const card = page.getByTestId("bot-panel-upcoming").locator("div.rounded-lg").first();
  await expect(card).toHaveCSS("border-radius", "12px");
  await expect(card).toHaveCSS("border-top-color", "rgba(26, 26, 26, 0.08)");
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await captureScreenshot(page, testInfo, "reference-panel");
});
