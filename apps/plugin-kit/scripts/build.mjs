#!/usr/bin/env node
// Bundles the superbot-plugin command into one JavaScript file that plain Node runs on Linux,
// macOS and Windows. Workspace packages ship TypeScript source, so they and their npm
// dependencies are bundled in. The native credential store binding stays external: it is loaded
// only when a command needs the saved session, from this package's own dependencies.
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = new URL("../", import.meta.url);
const templateModule = new URL("src/scaffold/template-files.ts", packageRoot);

/** esbuild options that bundle the command into `outfile`; the tests build with them too. */
export async function buildOptions(outfile) {
  // The starters are read from the repository's examples now and embedded in the bundle.
  const { TEMPLATE_FILES } = await import(templateModule.href);
  return {
    entryPoints: [fileURLToPath(new URL("src/main.ts", packageRoot))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    conditions: ["node"],
    external: ["@napi-rs/keyring"],
    // Bundled CommonJS dependencies may still call require.
    banner: {
      js: 'import { createRequire as __superbotRequire } from "node:module";\nconst require = __superbotRequire(import.meta.url);',
    },
    logLevel: "warning",
    plugins: [
      {
        name: "embedded-templates",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]scaffold[\\/]template-files\.ts$/ }, () => ({
            contents: `export const TEMPLATE_FILES = ${JSON.stringify(TEMPLATE_FILES)};\n`,
            loader: "js",
          }));
        },
      },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build(await buildOptions(fileURLToPath(new URL("dist/superbot-plugin.mjs", packageRoot))));
}
