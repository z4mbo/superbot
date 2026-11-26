import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppSubmissionInput } from "@rakazo/contracts";
import { APP_ID_MAX_LENGTH, APP_MANIFEST_FILE, APP_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { checkApp } from "@rakazo/plugin-sdk";
import { readAppFolder } from "@rakazo/plugin-sdk/node";
import { CommandError, withContext } from "../cli/errors.js";
import { writeNewFiles } from "./scaffold.js";
import { TEMPLATE_FILES } from "./template-files.js";

const APP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function titleOf(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Writes a new app folder from the Food Diary starter: `app.json`, `app.jsx` and `server.js`,
 * with the folder's name as the app's id. It keeps records on the server, runs server functions,
 * and offers a card, so every part of the SDK is there to change or remove.
 */
export async function scaffoldApp(
  folder: string,
  name: string | undefined,
  cwd: string,
): Promise<string[]> {
  const id = path.basename(path.resolve(cwd, folder));
  if (!APP_ID.test(id) || id.length > APP_ID_MAX_LENGTH)
    throw new CommandError(
      `Name the folder with 1 to ${APP_ID_MAX_LENGTH} lowercase letters or digits separated by single hyphens; it becomes the app id`,
    );
  const title = (name ?? titleOf(id)).trim();
  if (!title || title.length > APP_NAME_MAX_LENGTH)
    throw new CommandError(`The name must be 1 to ${APP_NAME_MAX_LENGTH} characters`);
  const manifest = {
    ...(JSON.parse(TEMPLATE_FILES.appManifest) as Record<string, unknown>),
    id,
    name: title,
    version: "0.1.0",
  };
  const entry = TEMPLATE_FILES.appEntry.replaceAll(
    'title="Food Diary"',
    `title={${JSON.stringify(title)}}`,
  );
  try {
    await mkdir(path.resolve(cwd, folder), { recursive: true });
  } catch (error) {
    throw withContext(`Creating ${folder}`, error);
  }
  return writeNewFiles(
    [
      [path.join(folder, APP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`],
      [path.join(folder, "app.jsx"), entry],
      [path.join(folder, "server.js"), TEMPLATE_FILES.appServer],
    ],
    cwd,
  );
}

/** An app folder that failed its check: each problem names the file and, often, the line. */
export class AppCheckError extends CommandError {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

/** Reads an app folder and checks it as the server does before it takes the app. */
export async function checkedAppFolder(folder: string, cwd: string) {
  const read = await readAppFolder(path.resolve(cwd, folder));
  if (!read.ok) throw new AppCheckError(read.errors);
  const check = checkApp({
    manifest: read.manifest,
    source: read.files.source,
    server: read.files.server,
  });
  if (!check.ok) throw new AppCheckError(check.errors);
  return { read, check };
}

/** An app folder as the server's submit takes it: the manifest as written, and its files. */
export async function appSubmission(folder: string, cwd: string): Promise<AppSubmissionInput> {
  const { read } = await checkedAppFolder(folder, cwd);
  const { manifest, files } = read;
  return {
    manifest: JSON.parse(files.manifestText.replace(/^﻿/, "")),
    files: [
      { path: manifest.entry, content: files.source, encoding: "utf8" },
      ...(manifest.server && files.server !== undefined
        ? [{ path: manifest.server, content: files.server, encoding: "utf8" as const }]
        : []),
      ...(manifest.icon && files.icon
        ? [
            {
              path: manifest.icon,
              content: files.icon.toString("base64"),
              encoding: "base64" as const,
            },
          ]
        : []),
    ],
  };
}
