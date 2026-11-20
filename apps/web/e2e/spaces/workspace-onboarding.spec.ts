import { expect, test } from "@playwright/test";
import { captureScreenshot, signupThroughForm } from "../helpers/helpers";

test("workspace setup invites a signed-in account before connecting a model", async ({
  browser,
}, testInfo) => {
  const owner = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext();
  const first = await owner.newPage();
  const second = await guest.newPage();
  const stamp = Date.now();
  await signupThroughForm(
    first,
    `workspace-owner-${stamp}@rakazo.test`,
    "password12",
    "Workspace Owner",
  );
  await expect(first.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Open Personal" })).toBeVisible();
  await captureScreenshot(first, testInfo, "workspace-onboarding");

  await first.getByRole("button", { name: "Create workspace" }).click();
  await first.getByLabel("Workspace name").fill("Weekend plans");
  await first.getByRole("button", { name: "Create", exact: true }).click();
  await expect(first.getByRole("button", { name: "Open Weekend plans" })).toBeVisible();
  await first.getByRole("button", { name: "Invite", exact: true }).click();
  await first.getByRole("menuitem", { name: "Copy invite link" }).click();
  await expect(first.getByText("Invite link copied")).toBeVisible();
  const url = await first.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/\/invite\//);

  await signupThroughForm(
    second,
    `workspace-guest-${stamp}@rakazo.test`,
    "password12",
    "Workspace Guest",
  );
  await expect(second.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Open Weekend plans" })).toHaveCount(0);
  await second.getByRole("button", { name: "Join with an invite" }).click();
  await second.getByLabel("Invite link").fill(url);
  await second.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(second.getByRole("heading", { name: "Join Weekend plans" })).toBeVisible();
  await captureScreenshot(second, testInfo, "workspace-invite-accept");
  await second.getByRole("button", { name: "Join", exact: true }).click();
  await expect(second.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Open Weekend plans" })).toBeVisible();
  await expect(second.getByText("Workspace Owner", { exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "Open Personal" })).toHaveCount(1);
  await expect(second.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
  await captureScreenshot(second, testInfo, "workspace-joined");
  await owner.close();
  await guest.close();
});
