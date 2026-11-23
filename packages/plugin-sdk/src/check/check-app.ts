import type { AppManifest } from "@rakazo/contracts";
import { checkPageSource } from "@rakazo/page-kit/validate";
import { appSurface, findAction, parseAppManifest } from "../manifest/manifest.js";
import { actionEffectProblems } from "../state/app-state.js";

/** What an app's code finds in scope beside the page kit. */
export const APP_GLOBALS = ["useAppState", "useAction", "ActionButton", "ActionForm"] as const;

/** Where the viewer finds the app's surface; set by the prelude the check compiles in. */
export const APP_SURFACE_GLOBAL = "__rakazoApp";
/** Where the viewer finds the app's stored state when the host passes it in. */
export const APP_STATE_GLOBAL = "__rakazoAppState";

export type AppCheck =
  | { ok: true; manifest: AppManifest; code: string; warnings?: string[] }
  | { ok: false; errors: string[] };

/** One line of JSON a script can hold, so error line numbers in the app stay its own. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
}

/** The viewer prelude declaring the app's permissions, actions and initial state. */
export function appPrelude(manifest: AppManifest): string {
  return `globalThis.${APP_SURFACE_GLOBAL}=${scriptJson(appSurface(manifest))};`;
}

const NAMED_ACTION = /\buseAction\(\s*(["'])([^"'\n]*)\1|\baction=(["'])([^"'\n]*)\3/g;

/** Action names the code spells out that the manifest does not declare. */
function undeclaredActions(source: string, manifest: AppManifest): string[] {
  const missing = new Set<string>();
  for (const match of source.matchAll(NAMED_ACTION)) {
    const name = match[2] ?? match[4] ?? "";
    if (!findAction(manifest, name)) missing.add(name);
  }
  return [...missing];
}

/**
 * Checks an app: its manifest, then its source against the page kit's rules with the app's
 * names in scope, then that the two agree. A passing app carries its viewer code, compiled once,
 * as a page's does. Like the page check, this catches mistakes; the sandboxed viewer and the
 * host's permission checks are the boundary.
 */
export function checkApp(input: { manifest: unknown; source: string }): AppCheck {
  const parsed = parseAppManifest(input.manifest);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  const errors = manifest.actions.flatMap(actionEffectProblems);
  for (const name of undeclaredActions(input.source, manifest))
    errors.push(`The code runs "${name}", which app.json does not declare in actions.`);
  if (manifest.actions.length === 0 && /\buseAction\(|<Action(?:Button|Form)\b/.test(input.source))
    errors.push("The code runs actions, but app.json declares none.");
  const page = checkPageSource(input.source, {
    globals: APP_GLOBALS,
    prelude: appPrelude(manifest),
  });
  if (!page.ok) errors.push(...page.errors);
  if (errors.length || !page.ok) return { ok: false, errors };
  return page.warnings?.length
    ? { ok: true, manifest, code: page.code, warnings: page.warnings }
    : { ok: true, manifest, code: page.code };
}
