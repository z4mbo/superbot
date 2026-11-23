import { extendPageGlobals } from "@rakazo/page-kit/runtime";
import { ActionButton, ActionForm, useAction, useAppState } from "./app-components.js";

/**
 * The page runtime with the app bridge added. It is the one viewer runtime: plain pages run in
 * it unchanged, and an app finds these names in scope beside the kit. The validator offers them
 * only to apps (APP_GLOBALS), so this list and that one name the same things.
 */
extendPageGlobals({ useAppState, useAction, ActionButton, ActionForm });
