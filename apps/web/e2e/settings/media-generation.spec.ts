import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { MediaCatalog } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openBotLibrary,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

/** Sends a scripted tool call and approves it when the run asks first. */
async function callTool(page: Page, tool: string, prompt: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(`call ${tool} with ${JSON.stringify({ prompt })}`);
  await page.keyboard.press("Enter");
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await allow.click();
}

test("connects an offline media provider and shows what it makes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `media-${Date.now()}@rakazo.test`, "password12", "Media Preview");
  await completeOnboarding(page);

  // Nothing is connected and this server has no media setup of its own.
  const settings = await openUserSettings(page, "models");
  const media = settings.getByTestId("media-settings");
  await expect(media.getByTestId("media-unavailable")).toBeVisible();

  await media.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("option", { name: "Scripted", exact: true }).click();
  const form = media.getByTestId("media-key-form");
  await expect(form.getByRole("heading", { name: "Connect Scripted" })).toBeVisible();
  await form.getByLabel("Key ID").fill("key-e2e");
  const secret = form.getByLabel("API key");
  await expect(secret).toHaveAttribute("type", "password");
  await secret.fill("fake-scripted-key");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toBeHidden();

  // The saved key shows only its id; the secret is never sent back.
  const row = media.getByTestId("media-provider-scripted");
  await expect(row).toContainText("key-e2e");
  await row.getByRole("button").click();
  await expect(form.getByLabel("API key")).toHaveValue("");
  await expect(form.getByLabel("API key")).toHaveAttribute("placeholder", "Saved");
  await expect(form.getByLabel("Key ID")).toHaveValue("key-e2e");
  await captureScreenshot(page, testInfo, "media-settings-saved-key");

  // A blank secret keeps the saved one while the key id changes.
  await form.getByLabel("Key ID").fill("key-e2e-2");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row).toContainText("key-e2e-2");

  // Connected models can be chosen; providers that are not connected cannot.
  const images = media.getByTestId("media-choice-image");
  await expect(images).toHaveText("Automatic");
  await images.click();
  await expect(page.getByRole("option", { name: "Scripted · Scripted image" })).toBeEnabled();
  await expect(page.getByRole("option", { name: "OpenAI (not connected)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await captureScreenshot(page, testInfo, "media-settings-image-choices");
  await page.getByRole("option", { name: "Scripted · Scripted image" }).click();
  await expect
    .poll(async () => (await rpc<MediaCatalog>(page, "media/catalog", {})).preference.image)
    .toEqual({ provider: "scripted", model: "scripted-image" });
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // A generated image carries its prompt, provider and model.
  await callTool(page, "generate_image", "A lighthouse at dusk");
  const image = page.getByTestId("generated-image-card");
  await expect(image).toContainText("A lighthouse at dusk");
  await expect(image).toContainText("Scripted · scripted-image");
  await expect(image.locator("img")).toBeVisible();
  await captureScreenshot(page, testInfo, "media-chat-generated-image");

  // A video shows its progress card until it is done, or says it could not be made.
  await callTool(page, "generate_video", "Waves on the shore [fail]");
  const card = page.getByTestId("media-generation-card");
  await expect(card).toContainText("Waves on the shore [fail]");
  await expect(card).toContainText("Making the video");
  await captureScreenshot(page, testInfo, "media-chat-video-pending");
  await expect(card).toContainText("Couldn't make the video", { timeout: 60_000 });
  await captureScreenshot(page, testInfo, "media-chat-video-failed");

  // The agent's Library marks the image as generated.
  await openBotLibrary(page);
  const files = page.getByTestId("bot-panel-files");
  await expect(files.getByRole("button").first()).toContainText("A lighthouse at dusk");
  await expect(files.getByRole("button").first()).toContainText("Scripted");
  await captureScreenshot(page, testInfo, "media-library-generated");

  // Removing the key leaves nothing that can make images.
  await openUserSettings(page, "models");
  await row.getByRole("button").click();
  await form.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toBeHidden();
  await expect(media.getByTestId("media-unavailable")).toBeVisible();
});
