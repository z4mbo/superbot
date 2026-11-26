import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { darkTokens } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const source = path("packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png");

// Match the Icon Composer portrait: the character sits 90 points below center.
const portrait = await sharp(source).resize(1024, 1024).png().toBuffer();
async function framed(background: string) {
  return sharp({ create: { width: 1024, height: 1114, channels: 4, background } })
    .composite([{ input: portrait, top: 90, left: 0 }])
    .extract({ left: 0, top: 0, width: 1024, height: 1024 })
    .png()
    .toBuffer();
}
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);
async function roundedCorners(input: Buffer) {
  return sharp(input)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}
const marketingSquare = await framed(darkTokens.background);
const marketingMark = await roundedCorners(marketingSquare);

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
}

// PNG frames in ICO are supported by modern Windows and browser favicon loaders.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index] ?? 0;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

async function webIcons(app: string, rounded: Buffer, square: Buffer) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}
await webIcons("www", marketingMark, marketingSquare);
await mkdir(path("apps/www/public/brand"), { recursive: true });
await png(marketingMark, "apps/www/public/brand/rakazo-mark.png", 256);
// The site header shows the mark at 36px; 72px covers 2x screens.
await sharp(marketingMark)
  .resize(72, 72)
  .webp({ quality: 90 })
  .toFile(path("apps/www/public/brand/rakazo-mark-72.webp"));
const logo = path("superbot-site/assets/logo.svg");
const mark = await sharp(logo, { density: 288 }).resize(1024, 1024).png().toBuffer();
const opaque = await sharp(mark).flatten({ background: "black" }).png().toBuffer();
await copyFile(logo, path("apps/web/public/superbot-mark.svg"));
await webIcons("web", mark, opaque);
await png(mark, "apps/desktop/assets/icon.png", 1024);
await ico(mark, "apps/desktop/assets/icon.ico", [16, 20, 24, 32, 40, 48, 64, 128, 256]);

async function padded(input: Buffer, size: number) {
  const margin = (1024 - size) / 2;
  return sharp(input)
    .resize(size, size)
    .extend({ top: margin, bottom: margin, left: margin, right: margin, background: "transparent" })
    .png()
    .toBuffer();
}
await writeFile(path("apps/desktop/assets/icon-macos.png"), await padded(mark, 824));
await mkdir(path("packages/ui-tokens/assets/Superbot.icon/Assets"), { recursive: true });
await writeFile(path("packages/ui-tokens/assets/Superbot.icon/Assets/face.png"), opaque);
await writeFile(path("apps/mobile/assets/icon.png"), opaque);
await png(opaque, "apps/mobile/assets/app-mark.png", 192);
await png(opaque, "apps/mobile/ios-widgets/Assets.xcassets/AppMark.imageset/app-mark.png", 180);
await png(mark, "apps/mobile/assets/favicon.png", 128);
await writeFile(path("apps/mobile/assets/splash-icon.png"), await padded(mark, 620));

// Android masks adaptive icons and uses the alpha channel alone for themed icons and notifications.
const faceMask = await sharp(opaque).extractChannel("red").raw().toBuffer();
const face = await sharp({
  create: { width: 1024, height: 1024, channels: 3, background: "white" },
})
  .joinChannel(faceMask, { raw: { width: 1024, height: 1024, channels: 1 } })
  .png()
  .toBuffer();
await writeFile(path("apps/mobile/assets/adaptive-icon.png"), face);
await writeFile(path("apps/mobile/assets/monochrome-icon.png"), face);
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "black" } })
  .png()
  .toFile(path("apps/mobile/assets/icon-background.png"));
await png(face, "apps/mobile/assets/notification-icon.png", 72);
