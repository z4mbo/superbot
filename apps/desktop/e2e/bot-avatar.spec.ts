import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Locator } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { shownWindow } from "./shown-window.js";

// The web app's dev server, which serves the shared avatar fixture. The cross-platform workflow
// starts one; without it there is nothing for the window to show.
const webUrl = process.env.RAKAZO_E2E_WEB_URL;
test.skip(!webUrl, "needs the web dev server (RAKAZO_E2E_WEB_URL)");

let userData: string;
let app: ElectronApplication | undefined;

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-desktop-avatar-"));
});

test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    await rm(userData, { recursive: true, force: true });
  }
});

function faceScale(avatar: Locator) {
  return avatar
    .locator(".rakazo-mascot-avatar-face")
    .evaluate((face) => new DOMMatrix(getComputedStyle(face).transform).a);
}

test("the desktop window draws bot avatars as turning solids", async () => {
  app = await electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      RAKAZO_PERFORMANCE_USER_DATA: userData,
      RAKAZO_WEB_URL: new URL("/e2e/fixtures/bot-avatar-states.html", webUrl).href,
    },
  });
  const page = await shownWindow(app);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const idle = page.locator('[data-state="idle"] .avatar-shape-0');
  const working = page.locator('[data-state="working"] .avatar-shape-0');
  await expect(idle).toBeVisible({ timeout: 60_000 });
  expect(await faceScale(idle)).toBe(1);
  await expect.poll(() => faceScale(working)).toBeLessThan(0.97);
  await page.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "bot-avatar-states.png"),
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => faceScale(working)).toBe(1);
  await page.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "bot-avatar-states-reduced-motion.png"),
  });
});
