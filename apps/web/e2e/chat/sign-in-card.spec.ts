import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

// The e2e server runs the offline password manager (SIGN_IN_SOURCE_PROVIDER=emulator), whose
// label the server sends, and the scripted bot, which asks it for a login on a fixture site.
const LABEL = "Emulator Passwords";

test("a bot signs in with a login the person approves in their password manager", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signup(page, `sign-in-card-${stamp}@rakazo.test`, "password12", "Sign In Card");
  await completeOnboarding(page);
  const composer = page.getByPlaceholder(/Message/);
  const cards = page.getByTestId("sign-in-card");

  // Nothing is connected yet: the card offers to connect, and the provider's page sends the
  // person back to the callback page, which finishes the connection.
  await composer.fill("sign in to the fixture site");
  await page.keyboard.press("Enter");
  const connectCard = cards.first();
  await expect(connectCard).toHaveAttribute("data-status", "needs_connection", { timeout: 60_000 });
  const [connectTab] = await Promise.all([
    page.waitForEvent("popup"),
    connectCard.getByRole("button", { name: `Connect ${LABEL}` }).click(),
  ]);
  await expect(connectTab.getByTestId("sign-in-source-callback")).toContainText("Connected", {
    timeout: 15_000,
  });
  await connectTab.close();

  // Asked again, the bot asks the password manager, and the card sends the person to review it.
  await composer.fill("sign in to the fixture site");
  await page.keyboard.press("Enter");
  const card = cards.nth(1);
  await expect(card).toHaveAttribute("data-status", "pending", { timeout: 60_000 });
  await expect(card.getByText("login.example.test", { exact: true })).toBeVisible();
  const review = card.getByRole("button", { name: `Review in ${LABEL}` });
  await expect(review).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-review-card");

  // The person approves in the password manager's app (the emulator approves on the first check
  // once the review is opened); the card follows the request from the server's signal.
  const [approvalTab] = await Promise.all([page.waitForEvent("popup"), review.click()]);
  await approvalTab.close();
  await expect(card).toHaveAttribute("data-status", "approved", { timeout: 30_000 });
  await expect(card).toContainText("Approved");
  await expect(card.getByRole("button")).toHaveCount(0);
  // The bot never saw the login: nothing in the chat holds the emulator's fixture values.
  for (const value of ["user@example.test", "fixture-password-1"])
    await expect(page.getByText(value)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-approved-card");
});
