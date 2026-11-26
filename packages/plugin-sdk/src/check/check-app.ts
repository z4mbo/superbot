import type { AppManifest } from "@rakazo/contracts";
import { appNeedsInstall } from "@rakazo/contracts";
import { checkPageSource } from "@rakazo/page-kit/validate";
import { appSurface, findAction, parseAppManifest } from "../manifest/manifest.js";
import { actionEffectProblems } from "../state/app-state.js";
import { checkAppServer } from "./check-server.js";

/** What an app's code finds in scope beside the page kit. */
export const APP_GLOBALS = [
  "useAppState",
  "useAction",
  "useQuery",
  "useCard",
  "ActionButton",
  "ActionForm",
] as const;

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

const NAMED_ACTION = /\buse(?:Action|Query)\(\s*(["'])([^"'\n]*)\1|\baction=(["'])([^"'\n]*)\3/g;
const NAMED_CARD = /\bcard\s*===?\s*(["'])([^"'\n]*)\1/g;

/** Action names the code spells out that the manifest does not declare. */
function undeclaredActions(source: string, manifest: AppManifest): string[] {
  const missing = new Set<string>();
  for (const match of source.matchAll(NAMED_ACTION)) {
    const name = match[2] ?? match[4] ?? "";
    if (!findAction(manifest, name)) missing.add(name);
  }
  return [...missing];
}

/** Read-only actions the code runs from a click, and actions it asks useQuery for that change things. */
function misusedActions(source: string, manifest: AppManifest): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/\buseQuery\(\s*(["'])([^"'\n]*)\1/g)) {
    const action = findAction(manifest, match[2]);
    if (action && !action.readOnly)
      problems.push(
        `useQuery("${action.name}") needs a read-only action; mark it "readOnly": true or run it with useAction.`,
      );
  }
  return [...new Set(problems)];
}

/** Card names the code compares against that the manifest does not declare. */
function undeclaredCards(source: string, manifest: AppManifest): string[] {
  const cards = new Set((manifest.cards ?? []).map((card) => card.name));
  const missing = new Set<string>();
  for (const match of source.matchAll(NAMED_CARD)) {
    const name = match[2] ?? "";
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !cards.has(name) && source.includes("useCard("))
      missing.add(name);
  }
  return [...missing];
}

/** Why a chat-saved page cannot be this app: hosted data, server code and network need an install. */
export const APP_NEEDS_INSTALL =
  "This app uses hosted data, server functions or network calls, which only an installed app has. Build it as an app folder, publish it with the Apps SDK and install it from Apps; a page saved in chat keeps its state on the page.";

/**
 * Checks an app: its manifest, then its source against the page kit's rules with the app's
 * names in scope, then that the two agree, then its server file when it has one. A passing app
 * carries its viewer code, compiled once, as a page's does. Like the page check, this catches
 * mistakes; the sandboxed viewer, the function sandbox and the host's permission checks are the
 * boundary. Without `server` (a page a bot saves in chat) an app that needs an install is refused.
 */
export function checkApp(input: { manifest: unknown; source: string; server?: string }): AppCheck {
  const parsed = parseAppManifest(input.manifest);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  if (input.server === undefined && appNeedsInstall(manifest))
    return { ok: false, errors: [APP_NEEDS_INSTALL] };
  const errors = manifest.actions.flatMap(actionEffectProblems);
  for (const name of undeclaredActions(input.source, manifest))
    errors.push(`The code runs "${name}", which app.json does not declare in actions.`);
  errors.push(...misusedActions(input.source, manifest));
  for (const name of undeclaredCards(input.source, manifest))
    errors.push(`The code shows a card "${name}", which app.json does not declare in cards.`);
  if (
    manifest.actions.length === 0 &&
    /\buse(?:Action|Query)\(|<Action(?:Button|Form)\b/.test(input.source)
  )
    errors.push("The code runs actions, but app.json declares none.");
  if (input.server !== undefined) {
    const server = checkAppServer(input.server, manifest);
    if (!server.ok) errors.push(...server.errors);
  }
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
