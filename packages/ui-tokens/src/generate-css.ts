import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderRustTokens, renderTokensCss } from "./index.js";

writeFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), renderTokensCss());
writeFileSync(
  fileURLToPath(new URL("../../../native/desktop/src/theme_tokens.rs", import.meta.url)),
  renderRustTokens(),
);
