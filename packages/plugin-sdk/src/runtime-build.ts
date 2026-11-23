import { createRequire } from "node:module";
import { buildPageRuntime } from "@rakazo/page-kit/runtime-build";

const require = createRequire(import.meta.url);

/** The viewer runtime with the app bridge, as one classic script hosts inline into the viewer. */
export function buildAppRuntime(): Promise<string> {
  return buildPageRuntime(require.resolve("@rakazo/plugin-sdk/runtime"));
}
