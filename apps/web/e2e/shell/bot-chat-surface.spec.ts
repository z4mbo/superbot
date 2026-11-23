import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

// The everyday surfaces a bot lives on: roster, chat thread, composer and settings.
test("a bot's chat, roster avatar and settings render in both themes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `chat-surface-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });

  const composer = page.getByRole("combobox", { name: /Message/ });
  const transcript = page.getByTestId("transcript");
  const text = "Draft the weekly update from the team notes.";
  await composer.fill(text);
  await composer.press("Enter");
  await expect(transcript.getByText(text, { exact: true })).toBeVisible();

  // The roster draws the same shared avatar as the chat.
  const avatar = page.locator("[data-roster-bot-id] svg.rakazo-mascot-avatar").first();
  await expect(avatar).toBeVisible();
  await expect(avatar.locator(".rakazo-mascot-avatar-slice")).toHaveCount(6);

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `bot-chat-surface-${theme}`);
  }

  await openUserSettings(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `bot-settings-surface-${theme}`);
  }
});
