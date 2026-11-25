import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  openNewBot,
  signup,
} from "../helpers/helpers";

test("a new bot keeps its edited name, label, look, and adjusted photo", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-profile-${stamp}@rakazo.test`, "password12", "Bot Profile");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await openNewBot(page);
  const create = page.getByTestId("create-bot-dialog");
  await create.getByPlaceholder("Name your Bot").fill("Sample Helper");
  await create.getByRole("button", { name: "capsule", exact: true }).click();
  await create.getByRole("button", { name: "Color #00C972" }).click();
  await captureScreenshot(page, testInfo, "bot-profile-create");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder("Message Sample Helper")).toBeVisible();

  await openBotPanel(page);
  const profile = page.getByTestId("bot-settings").getByTestId("bot-profile-header");
  await profile.getByRole("button", { name: "Edit name" }).click();
  await profile.getByRole("textbox", { name: "Name" }).fill("Sample Desk");
  await profile.getByRole("textbox", { name: "Name" }).press("Enter");
  await profile.getByRole("button", { name: "Edit label" }).click();
  await profile.getByRole("textbox", { name: "Label" }).fill("Weekly digest");
  await profile.getByRole("textbox", { name: "Label" }).press("Enter");
  await expect(profile.getByRole("button", { name: "Edit label" })).toHaveText("Weekly digest");

  await profile.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await studio.getByRole("button", { name: "blue", exact: true }).click();
  await studio.getByRole("tab", { name: "Upload", exact: true }).click();
  const photo = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#1CC3B0";
    ctx.fillRect(0, 0, 160, 200);
    ctx.fillStyle = "#FFAF38";
    ctx.fillRect(160, 0, 160, 200);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await studio.locator('input[type="file"]').setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  const cropper = studio.getByTestId("avatar-cropper");
  await expect(cropper).toBeVisible();
  await cropper.getByRole("slider", { name: "Zoom" }).fill("2");
  await cropper.getByRole("button", { name: "Image position" }).press("ArrowLeft");
  await captureScreenshot(page, testInfo, "bot-profile-adjust-photo");
  await cropper.getByRole("button", { name: "Set avatar" }).click();
  await expect(studio).toBeHidden();
  await expect(profile.locator('img[src^="data:image/webp"]')).toBeVisible();

  await page.reload();
  await openBotPanel(page);
  const reopened = page.getByTestId("bot-settings").getByTestId("bot-profile-header");
  await expect(reopened.getByRole("button", { name: "Edit name" })).toHaveText("Sample Desk");
  await expect(reopened.getByRole("button", { name: "Edit label" })).toHaveText("Weekly digest");
  await expect(reopened.locator('img[src^="data:image/webp"]')).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-profile-persisted");
});
