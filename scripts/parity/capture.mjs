#!/usr/bin/env node
// Photographs the seeded fixture at the reference app's sizes, in both themes, with DPR 1 on
// Chromium so text rasterizes the way the reference captures did.
//
//   PARITY_BASE_URL=http://127.0.0.1:5183 PARITY_FIXTURE=… PARITY_OUT=/path/to/shots \
//   node scripts/parity/capture.mjs [shot ...]
//
// Shots: chat (reference 20), working (25), settings (50), capsule-menu, model-menu,
// workspace-menu, avatars. With no names, every shot is taken.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "apps/web/package.json"))("@playwright/test");

const baseURL = process.env.PARITY_BASE_URL ?? "http://127.0.0.1:5183";
const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      process.env.PARITY_FIXTURE ?? path.join(root, "scripts/parity/fixture.example.json"),
    ),
    "utf8",
  ),
);
const out = path.resolve(process.env.PARITY_OUT ?? path.join(root, ".tmp/parity/shots"));
const chrome = process.env.PARITY_CHROME ?? "/run/current-system/sw/bin/google-chrome";
const sizes = (process.env.PARITY_SIZES ?? "1280x800,1440x900").split(",");
const themes = (process.env.PARITY_THEMES ?? "light,dark").split(",");
const wanted = new Set(process.argv.slice(2));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--force-device-scale-factor=1", "--font-render-hinting=none", "--disable-lcd-text"],
});

async function signedInPage(size, theme) {
  const [width, height] = size.split("x").map(Number);
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: process.env.PARITY_REDUCED_MOTION === "1" ? "reduce" : "no-preference",
  });
  await context.addInitScript((appearance) => {
    try {
      localStorage.setItem("rakazo.uiAppearance", appearance);
    } catch {}
  }, theme);
  const page = await context.newPage();
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: fixture.user.email, password: fixture.user.password },
    headers: { origin: new URL(baseURL).origin },
  });
  if (!response.ok()) throw new Error(`sign-in ${response.status()}`);
  return { page, context };
}

async function botId(page, key) {
  const spec = fixture.bots.find((bot) => (bot.key ?? bot.name) === key);
  const result = await page.request.post("/rpc/me", { data: { json: {} } });
  const me = (await result.json()).json;
  const spaces = await page.request.post("/rpc/spaces/list", { data: { json: {} } });
  const listed = (await spaces.json()).json;
  const space = (listed.spaces ?? listed).find((entry) => entry.id === me.spaceId) ?? listed[0];
  const bot = space.bots.find((entry) => entry.name === spec.name);
  if (!bot) throw new Error(`no bot named ${spec.name}`);
  return bot.id;
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Park the pointer far from the roster so idle avatars rest the way the reference shows them.
  await page.mouse.move(1275, 400);
  await page.waitForTimeout(1200);
}

const shots = {
  async chat(page) {
    await page.goto(`/app/${await botId(page, "main")}`);
    await page.getByTestId("composer-bar").waitFor({ timeout: 30_000 });
    await settle(page);
  },
  async working(page) {
    await page.goto(`/app/${await botId(page, "superbot")}`);
    await page.getByTestId("composer-bar").waitFor({ timeout: 30_000 });
    await settle(page);
  },
  async settings(page) {
    await page.goto(`/app/${await botId(page, "main")}?settings=general`);
    await page.getByRole("dialog").first().waitFor({ timeout: 10_000 });
    await settle(page);
  },
  async "model-menu"(page) {
    await page.goto(`/app/${await botId(page, "main")}`);
    await page.getByTestId("composer-bar").waitFor({ timeout: 30_000 });
    await settle(page);
    await page.getByTestId("capsule-model").click();
    await page.waitForTimeout(400);
  },
  async "workspace-menu"(page) {
    await page.goto(`/app/${await botId(page, "main")}`);
    await page.getByTestId("composer-bar").waitFor({ timeout: 30_000 });
    await settle(page);
    await page.getByTestId("capsule-workspace").click();
    await page.waitForTimeout(400);
  },
};

for (const [name, open] of Object.entries(shots)) {
  if (wanted.size > 0 && !wanted.has(name)) continue;
  for (const size of sizes) {
    for (const theme of themes) {
      const { page, context } = await signedInPage(size, theme);
      try {
        await open(page);
        const file = path.join(out, `${name}-${size}-${theme}.png`);
        await page.screenshot({ path: file });
        process.stdout.write(`${file}\n`);
      } catch (error) {
        process.stderr.write(`${name} ${size} ${theme}: ${error.message}\n`);
        await page
          .screenshot({ path: path.join(out, `failed-${name}-${size}-${theme}.png`) })
          .catch(() => undefined);
      } finally {
        await context.close();
      }
    }
  }
}
await browser.close();
