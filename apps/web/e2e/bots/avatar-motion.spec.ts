import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("photo working avatars show a visible ring while idle avatars stay plain", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const working = page.locator(".avatar-working");
  await expect(working).toBeVisible();
  await expect(working).toHaveAttribute("data-working", "true");
  const picture = working.locator(".rakazo-bot-avatar-picture");
  const ring = working.locator(".rakazo-bot-avatar-ring");
  await expect(picture).toBeVisible();
  await expect(ring).toBeVisible();

  const overflow = await working.evaluate((el) => getComputedStyle(el).overflowX);
  const pictureOverflow = await picture.evaluate((el) => getComputedStyle(el).overflowX);
  const ringAnimation = await ring.evaluate((el: SVGElement) => getComputedStyle(el).animationName);
  const ringColor = await ring.locator("circle").evaluate((el) => getComputedStyle(el).stroke);
  const pictureAnimation = await picture.evaluate((el) => getComputedStyle(el).animationName);
  const workingColor = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--status-working)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(overflow).not.toBe("hidden");
  expect(pictureOverflow).toBe("hidden");
  expect(ringAnimation).toBe("rakazo-avatar-spin");
  expect(ringColor).toBe(workingColor);
  expect(pictureAnimation).toBe("rakazo-avatar-breathe");
  const firstPictureTransform = await picture.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  const secondPictureTransform = await picture.evaluate((el) => getComputedStyle(el).transform);
  expect(secondPictureTransform).not.toBe(firstPictureTransform);

  const idle = page.locator(".avatar-idle");
  await expect(idle).toHaveAttribute("data-working", "false");
  await expect(idle.locator(".rakazo-bot-avatar-ring")).toHaveCount(0);
  await expect(idle.locator(".rakazo-bot-avatar-picture")).toHaveCSS("animation-name", "none");
  await captureScreenshot(page, testInfo, "avatar-photo-working-and-idle");
});

test("photo avatar animations stay still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".avatar-working");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-working", "true");

  const ring = avatar.locator(".rakazo-bot-avatar-ring");
  const picture = avatar.locator(".rakazo-bot-avatar-picture");
  await expect(ring).toBeVisible();
  const snapshot = () =>
    Promise.all([
      ring.evaluate((el: SVGElement) => ({
        animationName: getComputedStyle(el).animationName,
        transform: getComputedStyle(el).transform,
      })),
      picture.evaluate((el) => ({
        animationName: getComputedStyle(el).animationName,
        transform: getComputedStyle(el).transform,
      })),
    ]);
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(first[0]?.animationName).toBe("none");
  expect(first[1]?.animationName).toBe("none");
  expect(second).toEqual(first);
});

/** The outline a mark shows: the body path in the shared source its <use> points at. */
function outline(avatar: Locator) {
  return avatar.evaluate((svg) => {
    const href = svg.querySelector("use")?.getAttribute("href") ?? "";
    return document.querySelector(href)?.querySelector("path[mask]")?.getAttribute("d") ?? "";
  });
}

test("working marks redraw their shared outline frame by frame, with no ring", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const shape = page.locator(".avatar-shape-working");
  await expect(shape).toHaveAttribute("data-bot-mark-state", "working");
  // Only the working photo wears a ring; marks show their work in the drawing itself.
  await expect(page.locator(".rakazo-bot-avatar-ring")).toHaveCount(1);
  const first = await outline(shape);
  await expect.poll(() => outline(shape)).not.toBe(first);
  await expect(shape.locator("use")).toHaveCount(1);
});

test("a mark starts working in place and stops drawing while offscreen or hidden", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const avatar = page.locator(".avatar-organic");
  await expect(avatar).toHaveAttribute("data-bot-mark-state", "idle");
  await expect(avatar).toHaveAttribute("data-paused", "false");
  await avatar.locator("xpath=..").getByRole("button").click();
  await expect(avatar).toHaveAttribute("data-bot-mark-state", "working");
  const working = await outline(avatar);
  await expect.poll(() => outline(avatar)).not.toBe(working);

  const still = async () => {
    const before = await outline(avatar);
    await page.waitForTimeout(400);
    expect(await outline(avatar)).toBe(before);
  };
  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "2200px";
  });
  await expect(avatar).toHaveAttribute("data-paused", "true");
  await still();
  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "0";
  });
  await expect(avatar).toHaveAttribute("data-paused", "false");

  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  await expect(avatar).toHaveAttribute("data-paused", "true");
  await setHidden(false);
  await expect(avatar).toHaveAttribute("data-paused", "false");
  const resumed = await outline(avatar);
  await expect.poll(() => outline(avatar)).not.toBe(resumed);
});

/** The eye holes a mark shows, from the shared source its <use> points at. */
function eyes(avatar: Locator) {
  return avatar.evaluate((svg) => {
    const href = svg.querySelector("use")?.getAttribute("href") ?? "";
    return document.querySelector(href)?.querySelector("mask path")?.getAttribute("d") ?? "";
  });
}

test("a roster mark follows the pointer only inside its own box, and the open bot faces ahead", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const tile = page.locator(".roster-tile");
  const ada = page.locator(".roster-row").first();
  const bo = page.locator(".roster-row").nth(1);
  const mark = (host: Locator) => host.locator("svg[data-bot-mark]");
  await expect(mark(ada)).toBeVisible();
  // Each move below jumps straight to its point, so the pointer never crosses another box.
  const box = (await ada.boundingBox())!;
  const away = { x: box.x + box.width + 120, y: box.y + box.height / 2 };
  await page.mouse.move(away.x, away.y);
  const rest = {
    ada: await eyes(mark(ada)),
    bo: await eyes(mark(bo)),
    main: await eyes(mark(tile)),
  };

  // Elsewhere on the page the pointer moves nothing: once the hovered row below has turned, the
  // tile and the other row still show their resting drawings.
  await page.mouse.move(away.x, away.y - 160, { steps: 6 });

  // Inside the row, at its far end, only that row's mark turns, and it rests again on leaving.
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  await expect.poll(() => eyes(mark(ada))).not.toBe(rest.ada);
  expect(await eyes(mark(bo))).toBe(rest.bo);
  expect(await eyes(mark(tile))).toBe(rest.main);
  await captureScreenshot(page, testInfo, "avatar-roster-row-hovered");
  await page.mouse.move(away.x, away.y);
  await expect.poll(() => eyes(mark(ada))).toBe(rest.ada);

  // The open bot faces straight ahead, holds it once the pointer leaves, and rests when another
  // bot opens.
  await tile.click();
  await page.mouse.move(away.x, away.y);
  // Settled: the same drawing on two reads a quarter second apart, and not the resting one.
  let last = "";
  await expect
    .poll(
      async () => {
        const now = await eyes(mark(tile));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
  expect(last).not.toBe(rest.main);
  await bo.click();
  await page.mouse.move(away.x, away.y);
  await expect.poll(() => eyes(mark(tile))).toBe(rest.main);
  await expect.poll(() => eyes(mark(bo))).not.toBe(rest.bo);
});

test("with reduced motion a hovered mark faces ahead at once and rests when left", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const row = page.locator(".roster-row").first();
  const mark = row.locator("svg[data-bot-mark]");
  await expect(mark).toBeVisible();
  const rest = await eyes(mark);
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width - 4, box.y + 4);
  await expect.poll(() => eyes(mark)).not.toBe(rest);
  const facing = await eyes(mark);
  // Wherever the pointer goes inside the box, the face only ever looks straight ahead.
  await page.mouse.move(box.x + 6, box.y + box.height - 4);
  await expect.poll(() => eyes(mark)).toBe(facing);
  await page.mouse.move(box.x + box.width + 120, box.y);
  await expect.poll(() => eyes(mark)).toBe(rest);
});

test("a bot that stops working plays on for a moment, then rests exactly as before", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const avatar = page.locator(".avatar-organic");
  await expect(avatar).toHaveAttribute("data-bot-mark-state", "idle");
  const rest = await outline(avatar);
  const toggle = avatar.locator("xpath=..").getByRole("button");
  await toggle.click();
  await expect.poll(() => outline(avatar)).not.toBe(rest);
  await toggle.click();
  await expect(avatar).toHaveAttribute("data-bot-mark-state", "idle");
  await expect.poll(() => outline(avatar)).toBe(rest);
});
