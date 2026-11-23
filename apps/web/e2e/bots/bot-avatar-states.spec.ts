import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

/** The avatar's current turn, read from the face's horizontal scale (its cosine). */
function faceScale(avatar: Locator) {
  return avatar
    .locator(".rakazo-mascot-avatar-face")
    .evaluate((face) => new DOMMatrix(getComputedStyle(face).transform).a);
}

test("each bot state moves the extruded avatar its own way", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/bot-avatar-states.html");

  const turns = {
    idle: "none",
    working: "rakazo-mascot-turn-work",
    thinking: "rakazo-mascot-turn-think",
    waiting: "rakazo-mascot-turn-nudge",
    error: "rakazo-mascot-turn-shake",
  };
  for (const [state, animation] of Object.entries(turns)) {
    const avatars = page.locator(`[data-state="${state}"] svg.rakazo-mascot-avatar`);
    await expect(avatars).toHaveCount(8);
    await expect(avatars.first()).toHaveCSS("animation-name", animation);
  }

  // At rest the slices hide behind the face, so the avatar is the flat 2D shape.
  const idle = page.locator('[data-state="idle"] .avatar-shape-0');
  expect(await faceScale(idle)).toBe(1);
  await expect(idle.locator(".rakazo-mascot-avatar-slice").first()).toHaveCSS("opacity", "0");

  // Working, it turns: the face narrows and the extruded side shows.
  const working = page.locator('[data-state="working"] .avatar-shape-0');
  await expect.poll(() => faceScale(working)).toBeLessThan(0.97);
  await expect(working.locator(".rakazo-mascot-avatar-solid")).toHaveCSS(
    "animation-name",
    /rakazo-mascot-/,
  );

  // Hover turns an idle bot towards the pointer.
  await idle.hover();
  await expect.poll(() => faceScale(idle)).toBeLessThan(0.95);
  await page.mouse.move(0, 0);

  // Finishing work plays one settling turn.
  const done = page.locator('[data-state="done"] .avatar-shape-0');
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(done).toHaveAttribute("data-motion", "idle");
  await expect(done).toHaveAttribute("data-settling", "true");
  await expect(done).toHaveCSS("animation-name", "rakazo-mascot-turn-settle");

  await captureScreenshot(page, testInfo, "bot-avatar-states");
});

test("reduced motion keeps every avatar flat and facing forward", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/bot-avatar-states.html");
  for (const state of ["working", "thinking", "waiting", "error"]) {
    const avatar = page.locator(`[data-state="${state}"] .avatar-shape-0`);
    await expect(avatar).toHaveCSS("animation-name", "none");
    await expect(avatar.locator(".rakazo-mascot-avatar-solid")).toHaveCSS("animation-name", "none");
    expect(await faceScale(avatar)).toBe(1);
    // The still body keeps its outline when its motion is switched off.
    await expect(avatar.locator(".rakazo-mascot-avatar-body-idle")).not.toHaveCSS("d", "none");
  }
  const idle = page.locator('[data-state="idle"] .avatar-shape-0');
  await idle.hover();
  await page.waitForTimeout(500);
  expect(await faceScale(idle)).toBe(1);
});
