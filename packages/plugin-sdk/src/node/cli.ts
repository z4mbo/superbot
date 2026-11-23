import path from "node:path";
import { checkAppFolder } from "./app-folder.js";

/** `pnpm app:check <folder>`: checks an app folder as the product would before it opens it. */
async function main(args: readonly string[]) {
  const [command, folder] = args;
  if (command !== "check" || !folder) {
    console.error("Usage: app:check <app folder>");
    return 2;
  }
  // pnpm runs root scripts from the repository root; INIT_CWD is where the command was typed.
  const base = process.env.INIT_CWD ?? process.cwd();
  const result = await checkAppFolder(path.resolve(base, folder));
  if (!result.ok) {
    for (const error of result.errors) console.error(`✗ ${error}`);
    return 1;
  }
  for (const warning of result.warnings ?? []) console.warn(`! ${warning}`);
  console.log(`✓ ${result.manifest.name} ${result.manifest.version}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
