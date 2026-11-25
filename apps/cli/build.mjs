#!/usr/bin/env node
// Bundles the `superbot` command into one JavaScript file that plain Node runs on Linux, macOS and
// Windows. Workspace packages ship TypeScript source and npm packages are bundled in too, so the
// output needs nothing from the monorepo at runtime. The system credential store binding is a
// native module: it stays external and resolves from this package's own dependencies.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the bundle goes; the launcher in bin/ imports it. */
export const CLI_BUNDLE = path.join(here, "dist", "superbot.js");

export function cliBuildOptions(outfile = CLI_BUNDLE) {
  return {
    entryPoints: [path.join(here, "src", "main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    jsx: "automatic",
    // React and Ink pick their production builds from this.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // CommonJS dependencies inside an ES module bundle still call require for Node built-ins.
    banner: {
      js: 'import { createRequire as __superbotRequire } from "node:module";\nconst require = __superbotRequire(import.meta.url);',
    },
    // The keyring is a native binding, loaded at runtime from this package's dependencies.
    external: ["@napi-rs/keyring"],
    plugins: [withoutInkDevtools],
    legalComments: "none",
    logLevel: "warning",
  };
}

/**
 * Ink connects to React DevTools only while developing Ink apps. Bundled, that optional module
 * would become a static import of a package the command does not ship, so it is left out.
 */
const withoutInkDevtools = {
  name: "without-ink-devtools",
  setup(builder) {
    builder.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) =>
      /[\\/]ink[\\/]build[\\/]/.test(args.importer)
        ? { path: "ink-devtools", namespace: "without-ink-devtools" }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: "without-ink-devtools" }, () => ({
      contents: "export {};",
      loader: "js",
    }));
  },
};

/** Builds the bundle; tests build their own copy into a temporary folder. */
export function buildCli(outfile = CLI_BUNDLE) {
  return build(cliBuildOptions(outfile));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildCli(process.argv[2] ? path.resolve(process.argv[2]) : CLI_BUNDLE);
}
