import { PACKAGE_NAME } from "./version.js";

/** How this copy of the command was installed, read from where its script lives. */
export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "npx" | "pnpm-dlx" | "source";

/**
 * Package managers each keep global installs and one-off runs in folders of their own, so the
 * script's path tells them apart without asking any of them. A path outside every package folder
 * is a build from a source checkout.
 */
export function installMethod(scriptPath: string): InstallMethod {
  const at = scriptPath.replaceAll("\\", "/").toLowerCase();
  if (!at.includes(`/node_modules/${PACKAGE_NAME}/`)) return "source";
  if (at.includes("/_npx/")) return "npx";
  if (at.includes("/pnpm/") || at.includes("/.pnpm/")) {
    return at.includes("/dlx/") ? "pnpm-dlx" : "pnpm";
  }
  if (at.includes("/.bun/")) return "bun";
  if (at.includes("/yarn/") || at.includes("/.yarn/")) return "yarn";
  return "npm";
}

/** The command that moves this install to the newest release; undefined for a source checkout. */
export function updateCommand(method: InstallMethod): string | undefined {
  const latest = `${PACKAGE_NAME}@latest`;
  switch (method) {
    case "npm":
      return `npm install -g ${latest}`;
    case "pnpm":
      return `pnpm add -g ${latest}`;
    case "yarn":
      return `yarn global add ${latest}`;
    case "bun":
      return `bun add -g ${latest}`;
    case "npx":
      return `npx ${latest}`;
    case "pnpm-dlx":
      return `pnpm dlx ${latest}`;
    case "source":
      return undefined;
  }
}
