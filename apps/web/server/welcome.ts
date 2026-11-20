import { createReadStream, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";
import { CONTENT_TYPES } from "./missing-asset.js";
import type { Middleware } from "./preview-middleware.js";

const publicFiles = [
  "index.html",
  "NOTICE.txt",
  "licenses/*.txt",
  "docs/**/*.html",
  "assets/**/*.{css,js,svg,png,jpg,webp,woff,woff2,ttf,txt}",
];

function filesAt(directory: string) {
  const files = new Map<string, string>();
  for (const entry of globSync(publicFiles, { cwd: directory, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, file).split(path.sep).join("/");
    files.set(relative, file);
  }
  return files;
}

export function welcomePages(directory: string): Middleware {
  const files = filesAt(directory);
  return (req, res, next) => {
    const url = req.url ?? "";
    const pathname = url.split("?", 1)[0] ?? "";
    if (pathname !== "/welcome" && !pathname.startsWith("/welcome/")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const relative = pathname.slice("/welcome/".length);
    if (!pathname.endsWith("/") && files.has(relative ? `${relative}/index.html` : "index.html")) {
      res.writeHead(308, { location: `${pathname}/${url.slice(pathname.length)}` }).end();
      return;
    }
    const file = files.get(pathname.endsWith("/") ? `${relative}index.html` : relative);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-cache");
    if (req.method === "HEAD") res.end();
    else void pipeline(createReadStream(file), res).catch(() => res.destroy());
  };
}

export function welcomeSite(directory: string): Plugin {
  return {
    name: "superbot-welcome",
    configureServer(server) {
      server.middlewares.use(welcomePages(directory));
    },
    generateBundle() {
      for (const [relative, file] of filesAt(directory)) {
        this.emitFile({
          type: "asset",
          fileName: `welcome/${relative}`,
          source: readFileSync(file),
        });
      }
    },
  };
}
