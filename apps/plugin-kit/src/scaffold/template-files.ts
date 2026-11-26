import { readFileSync } from "node:fs";

/**
 * The files `init` copies, read from the repository's examples so the starters never drift from
 * them. The bundled command embeds this module's values at build time (scripts/build.mjs), so the
 * installed tool reads nothing from the repository.
 */
const repository = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repository), "utf8");

export const TEMPLATE_FILES = {
  converterManifest: read("examples/plugins/marketplace-unit-converter/manifest.json"),
  converterServer: read("examples/plugins/marketplace-unit-converter/server.ts"),
  converterPage: read("examples/plugins/marketplace-unit-converter/temperature.html"),
  converterReadme: read("apps/plugin-kit/src/scaffold/mcp-app-readme.md"),
  diaryManifest: read("examples/plugins/kcal-diary/plugin.json"),
  appManifest: read("examples/food-diary/app.json"),
  appEntry: read("examples/food-diary/app.jsx"),
  appServer: read("examples/food-diary/server.js"),
};
