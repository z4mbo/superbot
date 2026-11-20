#!/usr/bin/env node
// Build the public copy of superbot-site/ for static hosting: the files a Superbot server serves
// at /welcome/, plus the connect page, with the app's own links pointed at that page, a hosting
// config, and a manifest of every file. Usage: node scripts/build-superbot-site.mjs
// -> dist/superbot-landing/. The site itself has no build step; this only selects and copies.
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = path.join(root, "superbot-site");
export const OUT = path.join(root, "dist/superbot-landing");

/** `publicFiles` in apps/web/server/welcome.ts; scripts/checks/superbot-site.test.mjs holds them equal. */
export const SERVER_FILES = [
  "index.html",
  "NOTICE.txt",
  "licenses/*.txt",
  "docs/**/*.html",
  "assets/**/*.{css,js,svg,png,jpg,webp,woff,woff2,ttf,txt}",
];
/** The connect page is only for the hosted copy: a server already is the origin it connects to. */
export const PUBLIC_FILES = [...SERVER_FILES, "connect/index.html"];

/** The app routes the site links to, and the connect page's `next` for each. */
const APP_LINKS = new Map([
  ["/sign-in", "sign-in"],
  ["/sign-up", "sign-up"],
  ["/app", "app"],
]);
const connectLink = (next) => `/connect/?next=${next}`;
const CONNECT_LINKS = new Set([...APP_LINKS.values()].map(connectLink));

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** Static hosting only: no functions, rewrites, proxies or environment. */
export function hostingConfig() {
  const redirect = (source, next) => ({ source, destination: connectLink(next), permanent: false });
  return {
    framework: null,
    cleanUrls: false,
    trailingSlash: true,
    // With `trailingSlash` the host first sends `/app` to `/app/` and then matches a source
    // exactly, so every source ends in a slash; one without it would never match. The last one
    // takes anything under `/app/`, so a bookmarked conversation lands on the connect page too.
    redirects: [
      redirect("/sign-in/", "sign-in"),
      redirect("/sign-up/", "sign-up"),
      redirect("/app/:path(.*)", "app"),
    ],
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ],
  };
}

const toPosix = (file) => file.split(path.sep).join("/");

/** Every allowlisted file in `source`; a pattern that matches nothing is a broken allowlist. */
export function selectFiles(source) {
  const files = new Set();
  for (const pattern of PUBLIC_FILES) {
    const matches = globSync(pattern, { cwd: source, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => toPosix(path.relative(source, path.join(entry.parentPath, entry.name))));
    if (matches.length === 0) throw new Error(`superbot-site: ${pattern} matches no file`);
    for (const file of matches) files.add(file);
  }
  return [...files].sort();
}

/** Refuses internal notes, dotfiles, source maps and environment files. */
export function assertPublishable(file) {
  const name = path.posix.basename(file);
  if (file.split("/").some((part) => part.startsWith("."))) {
    throw new Error(`superbot-site: ${file} is a dotfile`);
  }
  if (/\.(md|map)$/i.test(name) || /(^|[._-])env([._-]|$)/i.test(name)) {
    throw new Error(`superbot-site: ${file} must not be published`);
  }
}

const TAG = /<([a-z][\w-]*)\b((?:[^"'>]|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /(\s+([:\w-]+)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const RESOURCE_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "xlink:href"]);
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** The page with its app links pointed at the connect page; anything else unexpected throws. */
export function rewriteHtml(text, file) {
  const fail = (problem) => {
    throw new Error(`superbot-site: ${file} ${problem}`);
  };
  // The hosting policy allows no inline script or style.
  if (/<style\b/i.test(text)) fail("has a <style> element");
  return text.replace(TAG, (_, rawTag, attributes) => {
    const tag = rawTag.toLowerCase();
    let hasSource = false;
    const rewritten = attributes.replace(
      ATTRIBUTE,
      (attribute, prefix, rawName, doubleQuoted, singleQuoted, unquoted) => {
        const name = rawName.toLowerCase();
        const value = doubleQuoted ?? singleQuoted ?? unquoted;
        if (name === "src") hasSource = true;
        if (name === "style") fail(`has an inline style on <${tag}>`);
        if (name.startsWith("on")) fail(`has an inline ${name} handler on <${tag}>`);
        if (/^\s*javascript:/i.test(value)) fail(`has a javascript: link on <${tag}>`);
        if (tag === "a" && name === "href") {
          const next = APP_LINKS.get(value);
          if (next) {
            const quote = singleQuoted === undefined ? '"' : "'";
            return `${prefix}${quote}${connectLink(next)}${quote}`;
          }
        }
        const resource = RESOURCE_ATTRIBUTES.has(name) || (tag === "link" && name === "href");
        if (resource && ABSOLUTE.test(value)) fail(`loads ${value} from another origin`);
        if (value.startsWith("/") && !(name === "href" && CONNECT_LINKS.has(value))) {
          fail(`links to ${value}, a root-absolute path the hosted copy does not know`);
        }
        return attribute;
      },
    );
    if (tag === "script" && !hasSource) fail("has an inline <script>");
    return `<${rawTag}${rewritten}>`;
  });
}

/** Stylesheets may only load their own relative files. */
export function assertStylesheet(text, file) {
  if (/@import\b/i.test(text)) throw new Error(`superbot-site: ${file} uses @import`);
  for (const [, , value] of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)) {
    if (value.startsWith("/") || ABSOLUTE.test(value)) {
      throw new Error(`superbot-site: ${file} loads ${value}, not a relative file`);
    }
  }
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${prefix}${entry.name}`;
      return entry.isDirectory()
        ? listFiles(path.join(directory, entry.name), `${relative}/`)
        : [relative];
    })
    .sort();
}

/** Builds the payload into `out`, replacing whatever was there, and returns its file list. */
export function buildSite({ source = SITE, out = OUT } = {}) {
  const inside = (parent, child) => !path.relative(parent, child).startsWith("..");
  if (inside(out, source) || inside(source, out)) {
    throw new Error("superbot-site: the output folder must sit outside the site");
  }
  const files = selectFiles(source);
  for (const file of files) assertPublishable(file);

  rmSync(out, { recursive: true, force: true });
  for (const file of files) {
    const from = path.join(source, file);
    const to = path.join(out, file);
    mkdirSync(path.dirname(to), { recursive: true });
    let contents = readFileSync(from);
    if (file.endsWith(".html")) contents = rewriteHtml(contents.toString("utf8"), file);
    if (file.endsWith(".css")) assertStylesheet(contents.toString("utf8"), file);
    writeFileSync(to, contents);
  }
  writeFileSync(path.join(out, "vercel.json"), `${JSON.stringify(hostingConfig(), null, 2)}\n`);

  const published = listFiles(out);
  const expected = [...files, "vercel.json"].sort();
  if (published.join("\n") !== expected.join("\n")) {
    throw new Error("superbot-site: the payload holds files outside the allowlist");
  }
  for (const file of published) assertPublishable(file);

  const manifest = published.map((file) => {
    const contents = readFileSync(path.join(out, file));
    const sha256 = createHash("sha256").update(contents).digest("hex");
    return { file, size: contents.length, sha256 };
  });
  writeFileSync(
    path.join(out, "MANIFEST.txt"),
    manifest.map(({ file, size, sha256 }) => `${sha256}  ${size}  ${file}\n`).join(""),
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = buildSite();
  const bytes = manifest.reduce((total, { size }) => total + size, 0);
  console.log(
    `${path.relative(process.cwd(), OUT) || "."}: ${manifest.length} files, ${bytes} bytes, plus MANIFEST.txt`,
  );
}
