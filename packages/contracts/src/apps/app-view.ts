import * as z from "zod";
import { APP_ACTIONS_MAX, appPermissionSchema } from "./app-manifest.js";

/** An app's stored state: a JSON object. */
export const appStateSchema = z.record(z.string(), z.json());

/**
 * What the app's viewer host needs to open an app page: the permissions it enforces on the app's
 * requests, the names of the actions it may pass on, and the stored state with its revision.
 */
export const appViewSchema = z.strictObject({
  name: z.string(),
  permissions: z.array(appPermissionSchema),
  actions: z.array(z.string()).max(APP_ACTIONS_MAX),
  state: appStateSchema,
  revision: z.number().int().nonnegative(),
  /** Actions that run a server function; only an installed app has them. */
  functions: z.array(z.string()).max(APP_ACTIONS_MAX).optional(),
  /** Of those, the read-only ones, which the view reads without a click. */
  queries: z.array(z.string()).max(APP_ACTIONS_MAX).optional(),
});
export type AppView = z.infer<typeof appViewSchema>;

export const appActionRunSchema = z.strictObject({
  state: appStateSchema,
  revision: z.number().int().nonnegative(),
  /** What a function-backed action returned. */
  result: z.json().optional(),
});
export type AppActionRunResult = z.infer<typeof appActionRunSchema>;
/** What a server function answered: JSON, as the sandbox hands it back. */
export type AppFunctionResult = NonNullable<AppActionRunResult["result"]> | null;
