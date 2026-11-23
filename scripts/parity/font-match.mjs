#!/usr/bin/env node
// Internal tool: ranks open-licence fonts against text the reference app rendered. Each sample
// is re-rendered in Chromium at DPR 1 with the measured size, line height, weight and colours,
// aligned on its ink box, and scored by mean absolute error over the union of both boxes.
//
//   PARITY_REFS=/path/to/screens PARITY_FONTS=/dir/with/fonts node scripts/parity/font-match.mjs
//
// PARITY_FONTS holds InterVariable.ttf, Geist-Variable.ttf and PublicSans.ttf (all SIL OFL 1.1).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharp = createRequire(path.join(root, "packages/ui-tokens/package.json"))("sharp");
const { chromium } = createRequire(path.join(root, "apps/web/package.json"))("@playwright/test");

const refs = process.env.PARITY_REFS;
const fonts = process.env.PARITY_FONTS;
const out = path.resolve(process.env.PARITY_REPORT ?? path.join(root, ".tmp/parity/font"));
if (!refs || !fonts) throw new Error("Set PARITY_REFS and PARITY_FONTS.");
mkdirSync(out, { recursive: true });

const CANDIDATES = {
  Inter: "InterVariable.ttf",
  Geist: "Geist-Variable.ttf",
  "Public Sans": "PublicSans.ttf",
};

// Coarse regions in 20-roster-grokbot-chat.png (light); the ink box inside each is what counts.
const SAMPLES = [
  {
    id: "chat-1",
    text: "Sì, controllo subito le issue su T3 Code.",
    box: [306, 408, 285, 30],
    size: 15,
    lh: 22,
    weight: 400,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#f0f0f0",
  },
  {
    id: "chat-2",
    text: "It works. I can reach the NixOS Server through T3 Code, and your MacBook",
    box: [306, 80, 548, 24],
    size: 15,
    lh: 22,
    weight: 400,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#f0f0f0",
  },
  {
    id: "chat-3",
    text: "Want me to use it now to finish Molly's setup on NixOS (the checkout and",
    box: [306, 222, 548, 24],
    size: 15,
    lh: 22,
    weight: 400,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#f0f0f0",
  },
  {
    id: "name",
    text: "What's New",
    box: [62, 220, 110, 24],
    size: 14,
    lh: 20,
    weight: 500,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#f5f5f5",
  },
  {
    id: "name-2",
    text: "BERTELLI",
    box: [62, 377, 110, 22],
    size: 14,
    lh: 20,
    weight: 500,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#f5f5f5",
  },
  {
    id: "preview",
    text: "Ecco l'export JSON",
    box: [62, 398, 78, 20],
    size: 13,
    lh: 18,
    weight: 400,
    track: 0.015,
    ink: "#1c1c1cad",
    bg: "#f5f5f5",
  },
  {
    id: "section",
    text: "Unassigned",
    box: [16, 185, 90, 22],
    size: 13,
    lh: 18,
    weight: 400,
    track: 0.015,
    ink: "#1c1c1cad",
    bg: "#f5f5f5",
  },
  {
    id: "capsule",
    text: "Grok Bot",
    box: [758, 20, 66, 22],
    size: 14,
    lh: 20,
    weight: 500,
    track: 0.01,
    ink: "#1c1c1c",
    bg: "#ffffff",
  },
  {
    id: "placeholder",
    text: "Message Grok Bot",
    box: [346, 751, 127, 22],
    size: 14,
    lh: 20,
    weight: 400,
    track: 0.01,
    ink: "#1b1b1b66",
    bg: "#ffffff",
  },
];

const reference = await sharp(path.join(refs, "1280x800/20-roster-grokbot-chat.png"))
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

function crop(image, [x, y, w, h]) {
  const { data, info } = image;
  const pixels = new Float32Array(w * h);
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const at = ((y + row) * info.width + (x + col)) * info.channels;
      pixels[row * w + col] = (data[at] + data[at + 1] + data[at + 2]) / 3;
    }
  }
  return { pixels, w, h };
}

function inkBox({ pixels, w, h }) {
  const bg = pixels[0];
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      if (Math.abs(pixels[row * w + col] - bg) > 30) {
        x0 = Math.min(x0, col);
        y0 = Math.min(y0, row);
        x1 = Math.max(x1, col);
        y1 = Math.max(y1, row);
      }
    }
  }
  return { x0, y0, x1, y1 };
}

function score(a, b) {
  const boxA = inkBox(a);
  const boxB = inkBox(b);
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const offX = boxB.x0 - boxA.x0 + dx;
      const offY = boxB.y0 - boxA.y0 + dy;
      const w = Math.max(boxA.x1 - boxA.x0, boxB.x1 - boxB.x0) + 3;
      const h = Math.max(boxA.y1 - boxA.y0, boxB.y1 - boxB.y0) + 3;
      let total = 0;
      for (let row = -1; row < h; row += 1) {
        for (let col = -1; col < w; col += 1) {
          const ax = boxA.x0 + col;
          const ay = boxA.y0 + row;
          const bx = ax + offX;
          const by = ay + offY;
          const va =
            ax >= 0 && ay >= 0 && ax < a.w && ay < a.h ? a.pixels[ay * a.w + ax] : a.pixels[0];
          const vb =
            bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.pixels[by * b.w + bx] : b.pixels[0];
          total += Math.abs(va - vb);
        }
      }
      best = Math.min(best, total / ((w + 1) * (h + 1)));
    }
  }
  return { mae: best, widthDelta: boxA.x1 - boxA.x0 - (boxB.x1 - boxB.x0) };
}

const browser = await chromium.launch({
  executablePath: process.env.PARITY_CHROME ?? "/run/current-system/sw/bin/google-chrome",
  args: ["--force-device-scale-factor=1"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

const dataUrls = {};
async function render(family, sample, weight, track) {
  dataUrls[family] ??=
    `data:font/ttf;base64,${readFileSync(path.join(fonts, CANDIDATES[family])).toString("base64")}`;
  const [x, y, w, h] = sample.box;
  await page.setContent(`<!doctype html><style>
    @font-face { font-family: "Cand"; src: url("${dataUrls[family]}"); font-weight: 100 900; }
    html, body { margin: 0; background: ${sample.bg}; -webkit-font-smoothing: antialiased; }
    div { position: absolute; left: ${x + 4}px; top: ${y + 1}px; white-space: pre; font-family: "Cand";
      font-size: ${sample.size}px; line-height: ${sample.lh}px; font-weight: ${weight};
      letter-spacing: ${track}em; color: ${sample.ink}; }
  </style><div>${sample.text}</div>`);
  await page.evaluate(() => document.fonts.ready);
  const shot = await page.screenshot({ clip: { x, y, width: w, height: h } });
  return sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

// One weight and one tracking per role (regular, medium) for each font, the way a theme would set
// them, so no sample is tuned on its own. Tracking is relative to the sample's measured value.
const WEIGHT_STEPS = [-30, -15, 0, 15, 30];
const TRACK_STEPS = [-0.02, -0.01, 0, 0.01];
const grid = new Map();
for (const family of Object.keys(CANDIDATES)) {
  for (const sample of SAMPLES) {
    const ref = crop(reference, sample.box);
    for (const dw of WEIGHT_STEPS) {
      for (const dt of TRACK_STEPS) {
        const image = await render(
          family,
          sample,
          sample.weight + dw,
          Number((sample.track + dt).toFixed(3)),
        );
        const result = score(ref, crop(image, [0, 0, sample.box[2], sample.box[3]]));
        grid.set(`${family}|${sample.id}|${dw}|${dt}`, result);
      }
    }
  }
}
await browser.close();

const roles = {
  regular: SAMPLES.filter((s) => s.weight === 400),
  medium: SAMPLES.filter((s) => s.weight === 500),
};
const lines = [
  `| Font | Settings | ${SAMPLES.map((s) => s.id).join(" | ")} | Mean |`,
  `|---|---|${SAMPLES.map(() => "---|").join("")}---|`,
];
for (const family of Object.keys(CANDIDATES)) {
  const pick = {};
  for (const [role, samples] of Object.entries(roles)) {
    let best = null;
    for (const dw of WEIGHT_STEPS) {
      for (const dt of TRACK_STEPS) {
        const mean =
          samples.reduce((sum, s) => sum + grid.get(`${family}|${s.id}|${dw}|${dt}`).mae, 0) /
          samples.length;
        if (!best || mean < best.mean) best = { dw, dt, mean };
      }
    }
    pick[role] = best;
  }
  for (const mode of ["native", "tuned"]) {
    const cells = SAMPLES.map((s) => {
      const role = s.weight === 500 ? "medium" : "regular";
      const { dw, dt } = mode === "native" ? { dw: 0, dt: 0 } : pick[role];
      return grid.get(`${family}|${s.id}|${dw}|${dt}`);
    });
    const mean = cells.reduce((sum, c) => sum + c.mae, 0) / cells.length;
    const settings =
      mode === "native"
        ? "400/500, measured tracking"
        : `regular ${400 + pick.regular.dw} (${pick.regular.dt >= 0 ? "+" : ""}${pick.regular.dt}em), medium ${500 + pick.medium.dw} (${pick.medium.dt >= 0 ? "+" : ""}${pick.medium.dt}em)`;
    lines.push(
      `| ${family} | ${settings} | ${cells.map((c) => `${c.mae.toFixed(2)} Δw${c.widthDelta}`).join(" | ")} | ${mean.toFixed(2)} |`,
    );
  }
}
writeFileSync(path.join(out, "font-match.md"), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
