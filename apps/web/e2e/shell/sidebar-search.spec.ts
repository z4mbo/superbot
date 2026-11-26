import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, signup } from "../helpers/helpers";

/** The desktop app, whose Cmd/Ctrl+Shift+F opens the search box above the roster. */
async function asDesktopApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "linux",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
      },
    });
  });
}

test("sidebar search opens the command palette, not a box above the roster", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-search-${Date.now()}@rakazo.test`, "password12", "Search Sample");
  await completeOnboarding(page);
  const sidebar = page.locator("aside").first();
  const trigger = sidebar.getByTestId("sidebar-search-trigger");
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await captureScreenshot(page, testInfo, "sidebar-search-closed");

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Command menu" });
  const search = page.getByTestId("command-palette-search");
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("placeholder", "Search Bots, Chats, Settings…");
  await expect(
    page.getByTestId("command-palette-list").locator("[cmdk-group-heading]").first(),
  ).toHaveText("Bots");
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-search-palette");

  await search.fill("Superbot");
  await expect(page.getByRole("option", { name: /Superbot/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toHaveCount(0);

  // Ctrl/Cmd+K still opens the same palette.
  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog).toBeVisible();
  await expect(search).toHaveValue("");
});

test("the desktop search shortcut filters the roster without moving chats mid-click", async ({
  page,
}, testInfo) => {
  await asDesktopApp(page);
  await signup(page, `sidebar-filter-${Date.now()}@rakazo.test`, "password12", "Filter Sample");
  await completeOnboarding(page);
  const sidebar = page.locator("aside").first();
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await expect(search).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(search).toBeFocused();
  // Password managers leave it alone.
  await expect(search).toHaveAttribute("autocomplete", "off");
  await expect(search).toHaveAttribute("name", "sidebar-search");
  await captureScreenshot(page, testInfo, "sidebar-search-open");

  // Leaving an empty field keeps the roster still, so a chat click lands.
  const chief = sidebar.getByRole("button", { name: /^Superbot/ }).first();
  const before = await chief.boundingBox();
  await chief.click();
  await expect(search).toBeVisible();
  expect((await chief.boundingBox())?.y).toBe(before?.y);

  await search.fill("no roster matches");
  const originalSearch = (await search.elementHandle())!;
  // These synthetic keyboard events exercise the browser event flags; they do not start an OS IME.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await search.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(search).toBeVisible();
    expect(await originalSearch.evaluate((element) => element.isConnected)).toBe(true);
    await expect(search).toHaveValue("no roster matches");
  }
  await captureScreenshot(page, testInfo, "sidebar-search-composing-escape");
  await search.press("Escape");
  await expect(search).toHaveCount(0);

  // A match keeps its chat on the list, and closing drops the typed text.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(search).toHaveValue("");
  await search.fill("Superbot");
  await expect(chief).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
});

test("a failed chat search says so instead of No results", async ({ page }, testInfo) => {
  await signup(
    page,
    `sidebar-search-failed-${Date.now()}@rakazo.test`,
    "password12",
    "Search Fail",
  );
  await completeOnboarding(page);
  let failSearch = true;
  await page.route("**/rpc/search/query", (route) =>
    failSearch ? route.fulfill({ status: 502 }) : route.fallback(),
  );
  await page.locator("aside").first().getByTestId("sidebar-search-trigger").click();
  const palette = page.getByTestId("command-palette");
  await page.getByTestId("command-palette-search").fill("quarterly notes");

  const failure = palette.getByRole("alert");
  await expect(failure).toHaveText("Could not reach the server");
  await expect(palette.getByText("No results", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-search-failed");

  failSearch = false;
  const retried = page.waitForRequest("**/rpc/search/query");
  await palette.getByRole("button", { name: "Try again", exact: true }).click();
  expect((await retried).postData()).toContain("quarterly notes");
  await expect(palette.getByText("No results", { exact: true })).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test("a bot found by the desktop search can be pinned from its result", async ({
  page,
}, testInfo) => {
  await asDesktopApp(page);
  await signup(page, `sidebar-search-pin-${Date.now()}@rakazo.test`, "password12", "Search Pin");
  await completeOnboarding(page);
  // The main bot is already pinned for good, so a bot of the person's own is pinned.
  await createNamedBot(page, "Scout");
  const sidebar = page.locator("aside").first();
  await page.keyboard.press("ControlOrMeta+Shift+F");
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("Scout");

  const result = sidebar.getByRole("button", { name: /^Scout/ }).first();
  await result.click({ button: "right" });
  const pin = page.getByRole("menuitem", { name: "Pin", exact: true });
  await expect(pin).toBeVisible();
  await captureScreenshot(page, testInfo, "sidebar-search-result-menu");
  await pin.click();

  await search.press("Escape");
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Scout");
});
