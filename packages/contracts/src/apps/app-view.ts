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
});
export type AppView = z.infer<typeof appViewSchema>;

export const appActionRunSchema = z.strictObject({
  state: appStateSchema,
  revision: z.number().int().nonnegative(),
});
