import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

// A test card number and code: fixture values only.
const PAN = "4242 4242 4242 4242";
const CVC = "123";

test("sends a card from a Secure form for one use, keeping it out of the chat and the Vault", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secure-form-${stamp}@rakazo.test`, "password12", "Secure Form");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill("show a card form");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("secure-form-label")).toHaveText("Secure form");
  await captureScreenshot(page, testInfo, "secure-form");

  await card.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByTestId("vault-editor");
  await form.getByLabel("Card number", { exact: true }).fill(PAN);
  await form.getByLabel("Expiry", { exact: true }).fill("0830");
  await form.getByLabel("Security code", { exact: true }).fill(CVC);
  const saveToVault = form.getByRole("switch", { name: "Save to Vault" });
  await expect(saveToVault).toBeChecked();
  await saveToVault.click();
  await captureScreenshot(page, testInfo, "secure-form-card-once");
  await form.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "secure-form-sent");
  // Nothing went into the Vault, and the transcript keeps no number or code.
  expect(await rpc<unknown[]>(page, "vault/list", { scope: "account" })).toHaveLength(0);
  const history = JSON.stringify(await rpc(page, "threads/messages", { botId }));
  for (const value of [PAN, PAN.replaceAll(" ", "")]) expect(history).not.toContain(value);
  expect(history).not.toMatch(/"cvc"/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(PAN)).toHaveCount(0);
});
