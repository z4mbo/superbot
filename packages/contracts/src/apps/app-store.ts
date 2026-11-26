import * as z from "zod";
import { Id } from "../ids.js";
import { APP_PATH_MAX_LENGTH, appPermissionSchema } from "./app-manifest.js";

/** One file of an app folder as it is published: text for code, base64 for an image. */
export const AppFileSchema = z.strictObject({
  path: z.string().min(1).max(APP_PATH_MAX_LENGTH),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
export type AppFile = z.infer<typeof AppFileSchema>;

/** The most files an app folder may publish: its entry, its server file and its icon. */
export const APP_FILES_MAX = 3;
/** The most an app's icon may take, decoded. */
export const APP_ICON_MAX_BYTES = 128 * 1024;
/** A request carrying an app: the page and server limits plus a base64 icon, with room for JSON. */
export const APP_SUBMISSION_MAX_CHARS = 768 * 1024;

/**
 * An app as its author publishes it: the manifest as written in `app.json` and the files it
 * names. The server parses and checks all of it; nothing here is trusted as sent.
 */
export const AppSubmissionInputSchema = z.object({
  manifest: z.unknown(),
  files: z.array(AppFileSchema).min(1).max(APP_FILES_MAX),
});
export type AppSubmissionInput = z.infer<typeof AppSubmissionInputSchema>;

export const AppSubmissionResultSchema = z.object({
  submissionId: Id,
  releaseId: Id,
  status: z.literal("pending"),
});

/**
 * What an app reaches beyond its page, named so the person sees it before allowing it and can
 * review it later: the hosts its functions call, the collections it keeps, whether it runs code
 * on the platform. Empty for an app that does none of these.
 */
const AppAccessShape = {
  hosts: z.array(z.string()).default([]),
  collections: z.array(z.string()).default([]),
  server: z.boolean().default(false),
};

/** A reviewed app version anyone signed in can install. */
export const AppListingSchema = z.object({
  releaseId: Id,
  appId: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  /** A data URL of the app's icon, or null for the letter fallback. */
  icon: z.string().nullable(),
  /** What installing asks the person to allow, in the manifest's order. */
  permissions: z.array(appPermissionSchema),
  /** Content hash of this version, sent back with the install so consent covers exactly it. */
  digest: z.string(),
  ...AppAccessShape,
});
export type AppListing = z.infer<typeof AppListingSchema>;

/** An app installed in the selected Space, with what the person allowed. */
export const AppInstallSchema = z.object({
  id: Id,
  releaseId: Id,
  appId: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  icon: z.string().nullable(),
  granted: z.array(appPermissionSchema),
  createdAt: z.string(),
  ...AppAccessShape,
});
export type AppInstall = z.infer<typeof AppInstallSchema>;

export const AppInstallInputSchema = z.object({
  releaseId: Id,
  digest: z.string().max(100),
  /** Every permission the version asks for: consent is to the whole list, never part of it. */
  grant: z.array(appPermissionSchema).max(16),
});

/** What the sandboxed viewer needs to run an installed app, and the bridge to allow. */
export const AppLaunchSchema = z.object({
  installId: Id,
  appId: z.string(),
  name: z.string(),
  version: z.string(),
  /** The app compiled for the page viewer. */
  code: z.string(),
  granted: z.array(appPermissionSchema),
});
export type AppLaunch = z.infer<typeof AppLaunchSchema>;
