import { createRequire } from "node:module";
import type { AppManifest } from "@rakazo/contracts";
import { APP_SERVER_MAX_BYTES } from "@rakazo/contracts";
import type * as Esbuild from "esbuild";
import type { Message } from "esbuild";

// Loaded on the first server file checked: a page or an app without one never starts esbuild.
const load = () => createRequire(import.meta.url)("esbuild") as typeof Esbuild;

export type ServerCheck = { ok: true; exports: string[] } | { ok: false; errors: string[] };

const MAX_REPORTED = 20;
const UNRESOLVED = /^Could not resolve "(.*)"/;

function describe(path: string, message: Message): string {
  const at = message.location ? `${path} line ${message.location.line}` : path;
  const unresolved = UNRESOLVED.exec(message.text);
  return unresolved
    ? `${at}: imports "${unresolved[1]}"; a server file is one file with no imports.`
    : `${at}: ${message.text}`;
}

/**
 * Checks an app's server file before it is published: it parses as one JavaScript module with
 * no imports, fits the size limit, and exports every function an action runs. Nothing runs here;
 * the sandbox the platform runs it in is the boundary, and checks again that each is a function.
 */
export function checkAppServer(
  source: string,
  manifest: Pick<AppManifest, "actions" | "server">,
): ServerCheck {
  const path = manifest.server ?? "server.js";
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > APP_SERVER_MAX_BYTES)
    return {
      ok: false,
      errors: [`${path}: the file is ${bytes} bytes; the limit is ${APP_SERVER_MAX_BYTES}.`],
    };
  let exports: string[];
  try {
    const built = load().buildSync({
      stdin: { contents: source, sourcefile: path, loader: "js" },
      bundle: true,
      platform: "neutral",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    exports = Object.values(built.metafile.outputs)[0]?.exports ?? [];
  } catch (error) {
    const messages = (error as { errors?: Message[] }).errors;
    if (!Array.isArray(messages)) throw error;
    return { ok: false, errors: messages.slice(0, MAX_REPORTED).map((m) => describe(path, m)) };
  }
  const errors: string[] = [];
  for (const action of manifest.actions)
    if (action.run !== undefined && !exports.includes(action.run))
      errors.push(`${path}: exports no function "${action.run}", which ${action.name} runs.`);
  return errors.length ? { ok: false, errors } : { ok: true, exports };
}
