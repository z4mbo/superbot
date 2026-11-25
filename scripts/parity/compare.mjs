#!/usr/bin/env node
// Internal iteration tool: compares captures with the reference app's screenshots and writes,
// per pair, a side-by-side, a 50% blend, a ×3 difference and a score (mean absolute error per
// channel, 0–255, and the share of pixels that differ by more than a threshold).
//
//   PARITY_REFS=/path/to/reference/screens PARITY_SHOTS=… PARITY_REPORT=… \
//   node scripts/parity/compare.mjs
//
// Pairs are listed in PAIRS below: a capture, a reference and an optional region.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharp = createRequire(path.join(root, "packages/ui-tokens/package.json"))("sharp");

const refs = process.env.PARITY_REFS;
if (!refs) throw new Error("Set PARITY_REFS to the folder holding the reference screens.");
const shots = path.resolve(process.env.PARITY_SHOTS ?? path.join(root, ".tmp/parity/shots"));
const report = path.resolve(process.env.PARITY_REPORT ?? path.join(root, ".tmp/parity/report"));
const threshold = Number(process.env.PARITY_THRESHOLD ?? 24);
mkdirSync(report, { recursive: true });

const SIDEBAR = { left: 0, top: 0, width: 280, height: 800 };
const CAPSULE = { left: 700, top: 4, width: 160, height: 54 };
const COMPOSER = { left: 290, top: 730, width: 980, height: 64 };
const MAIN = { left: 280, top: 0, width: 1000, height: 800 };

/** [name, capture, reference, region?] */
const PAIRS = [];
for (const theme of ["light", "dark"]) {
  const suffix = theme === "dark" ? "-dark" : "";
  const ref = (file) => `1280x800/${file}${suffix}.png`;
  PAIRS.push(
    [`chat-20-${theme}`, `chat-1280x800-${theme}.png`, ref("20-roster-grokbot-chat")],
    [`chat-25-${theme}`, `working-1280x800-${theme}.png`, ref("25-chat-superbot-working")],
    [`sidebar-21-${theme}`, `chat-1280x800-${theme}.png`, ref("21-sidebar-roster"), SIDEBAR],
    [`main-20-${theme}`, `chat-1280x800-${theme}.png`, ref("20-roster-grokbot-chat"), MAIN],
    [
      `capsule-34-${theme}`,
      `working-1280x800-${theme}.png`,
      ref("34-header-capsule-full"),
      CAPSULE,
    ],
    [`composer-40-${theme}`, `chat-1280x800-${theme}.png`, ref("40-composer-rest"), COMPOSER],
    [`settings-50-${theme}`, `settings-1280x800-${theme}.png`, ref("50-settings-general")],
    [
      `chat-20-1440-${theme}`,
      `chat-1440x900-${theme}.png`,
      `1440x900/20-roster-grokbot-chat${suffix}.png`,
    ],
  );
}

async function raw(file, region) {
  let image = sharp(file).removeAlpha();
  if (region) image = image.extract(region);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

const rows = [];
for (const [name, capture, reference, region] of PAIRS) {
  let a;
  let b;
  try {
    a = await raw(path.join(shots, capture), region);
    b = await raw(path.join(refs, reference), region);
  } catch {
    continue;
  }
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    rows.push({
      name,
      error: `size ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`,
    });
    continue;
  }
  const { width, height, channels } = a.info;
  const blend = Buffer.alloc(a.data.length);
  const diff = Buffer.alloc(a.data.length);
  let total = 0;
  let differing = 0;
  for (let index = 0; index < a.data.length; index += channels) {
    let worst = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const delta = Math.abs(a.data[index + channel] - b.data[index + channel]);
      total += delta;
      worst = Math.max(worst, delta);
      blend[index + channel] = (a.data[index + channel] + b.data[index + channel]) >> 1;
      diff[index + channel] = Math.min(255, delta * 3);
    }
    if (worst > threshold) differing += 1;
  }
  const mae = total / a.data.length;
  const percent = (100 * differing) / (width * height);
  const options = { raw: { width, height, channels } };
  const tile = (data) => sharp(data, options).png().toBuffer();
  const [left, right, blended, delta] = await Promise.all([
    tile(a.data),
    tile(b.data),
    tile(blend),
    tile(diff),
  ]);
  const gap = 8;
  await sharp({
    create: {
      width: width * 4 + gap * 3,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 255 },
    },
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: width + gap, top: 0 },
      { input: blended, left: 2 * (width + gap), top: 0 },
      { input: delta, left: 3 * (width + gap), top: 0 },
    ])
    .png()
    .toFile(path.join(report, `${name}.png`));
  rows.push({ name, mae: Number(mae.toFixed(2)), percent: Number(percent.toFixed(2)) });
}

const lines = [
  "| Screen | MAE (0-255) | Pixels over threshold |",
  "|---|---|---|",
  ...rows.map((row) =>
    row.error
      ? `| ${row.name} | ${row.error} | |`
      : `| ${row.name} | ${row.mae} | ${row.percent}% |`,
  ),
];
writeFileSync(path.join(report, "scores.md"), `${lines.join("\n")}\n`);
writeFileSync(path.join(report, "scores.json"), `${JSON.stringify(rows, null, 2)}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
