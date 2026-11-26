import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

// Geometry measured on the desktop reference at 1280x800, DPR 1.
test.use({ viewport: { width: 1280, height: 800 } });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not laid out");
  return found;
}

test("the Private pill shows who can use the bot and invites people to its Space", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-share-${stamp}@rakazo.test`, "password12", "Share Owner");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const pill = page.getByTestId("bot-access-trigger");
  await expect(pill).toHaveText("Private");
  const found = await box(pill);
  expect(found.height).toBe(36);
  await captureScreenshot(page, testInfo, "bot-access-pill");

  await pill.click();
  const popover = page.getByTestId("bot-share-popover");
  await expect(popover.getByText("Share this Bot", { exact: true })).toBeVisible();
  await expect(popover.getByTestId("bot-share-intro")).toContainText("Bring your team in");
  await expect(popover.getByTestId("bot-access-summary")).toHaveText("Only you");
  const owner = popover.getByRole("list", { name: "Who has access" }).getByRole("listitem");
  await expect(owner).toHaveCount(1);
  await expect(owner).toContainText("Share Owner");
  await expect(owner).toContainText("(You)");
  await expect(owner).toContainText("Owner");
  await captureScreenshot(page, testInfo, "bot-share-popover");

  // Someone from outside gets an invitation to the bot's Space, with its link to share by hand.
  const field = popover.getByRole("textbox", { name: "Add people by email" });
  await field.fill(`teammate-${stamp}@rakazo.test`);
  await popover.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(popover.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/invite\//);
  // Until they accept, the bot is still only yours.
  await expect(popover.getByTestId("bot-access-summary")).toHaveText("Only you");

  // The intro can be put away, and stays away.
  await popover.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(popover.getByTestId("bot-share-intro")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pill.click();
  await expect(popover.getByTestId("bot-share-intro")).toHaveCount(0);
});

test("the bot's profile takes the chat's place and closes back to it", async ({
  page,
}, testInfo) => {
  await signup(page, `bot-profile-page-${Date.now()}@rakazo.test`, "password12", "Profile Page");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  // From the panel's gear: the profile covers the chat column, and closing it returns to the panel.
  await openBotPanel(page);
  await page.getByTestId("bot-settings-open").click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-full-page", "true");
  const profile = page.getByTestId("bot-profile-page");
  await expect(profile).toBeVisible();
  const [sidebar, page_] = await Promise.all([box(page.locator("aside").first()), box(panel)]);
  expect(page_.x).toBe(sidebar.x + sidebar.width);
  expect(page_.width).toBe(1280 - sidebar.width);
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(profile.getByText("Private to you", { exact: true })).toBeVisible();
  await expect(profile.getByTestId("bot-access-trigger")).toHaveText("Private");
  await expect(profile.getByRole("tab", { name: "General" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(profile.getByTestId("bot-profile-connectors")).toContainText(
    "This Bot has no connectors yet",
  );
  await expect(profile.getByTestId("bot-profile-vault")).toContainText(
    "This Bot has no vault logins yet",
  );
  const label = profile
    .getByTestId("bot-profile-connectors")
    .locator('[data-slot="section-heading"]');
  await expect(label).toHaveCSS("font-size", "13px");
  await captureScreenshot(page, testInfo, "bot-profile-general");

  await profile.getByRole("tab", { name: "Knowledge" }).click();
  await expect(profile.getByTestId("bot-profile-skills")).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-profile-knowledge");

  // Add opens the screen that manages them.
  await profile.getByTestId("bot-profile-skills").getByRole("button", { name: "Add" }).click();
  await expect(page).toHaveURL(/[?&]skills/);
  await page.keyboard.press("Escape");
  await expect(profile).toBeVisible();

  await profile.getByRole("button", { name: "Close profile", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await expect(panel).toHaveCSS("width", "320px");

  // From the roster's Edit Profile, closing goes straight back to the chat.
  await page.getByRole("button", { name: "Close panel" }).click();
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Superbot/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile", exact: true }).click();
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: "Close profile", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible();
});
