import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import {
  AppInstallInputSchema,
  AppInstallSchema,
  AppLaunchSchema,
  AppListingSchema,
  AppSubmissionInputSchema,
  AppSubmissionResultSchema,
} from "./app-store.js";

export const appStoreRpc = {
  apps: {
    /** Reviewed apps, newest version of each, matching the query. */
    catalog: oc
      .input(z.object({ query: z.string().trim().max(200).default("") }))
      .output(z.array(AppListingSchema)),
    /** Apps installed in the selected Space. */
    installed: oc.output(z.array(AppInstallSchema)),
    /** Sends an app version for review; it is listed once an admin approves it. */
    submit: oc.input(AppSubmissionInputSchema).output(AppSubmissionResultSchema),
    install: oc.input(AppInstallInputSchema).output(AppInstallSchema),
    uninstall: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    /** The installed app's code for the sandboxed viewer, with only what was granted. */
    launch: oc.input(z.object({ id: Id })).output(AppLaunchSchema),
  },
};
