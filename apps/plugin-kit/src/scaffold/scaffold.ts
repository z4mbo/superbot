import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import type { RegistryManifest } from "@rakazo/plugin-sdk/registry";
import {
  normalizeRegistryManifest,
  readRegistryManifest,
  registryManifestText,
} from "@rakazo/plugin-sdk/registry";
import type { Template } from "../cli/commands.js";
import { CommandError, errorText, withContext } from "../cli/errors.js";
import { checkSlug } from "../manifest/manifest-file.js";
import { TEMPLATE_FILES } from "./template-files.js";

function starterSkill(name: string): RegistryManifest {
  return {
    schemaVersion: 1,
    name,
    description: "Summarize the main points in the supplied text.",
    parts: [
      {
        kind: "skill",
        id: "summary",
        instructions: "Summarize the supplied text in three bullet points.",
      },
    ],
  };
}

function example(text: string, name: string | undefined): RegistryManifest {
  const manifest = readRegistryManifest(new TextEncoder().encode(text));
  return name === undefined ? manifest : { ...manifest, name };
}

function starter(template: Template, slug: string, name: string | undefined): RegistryManifest {
  switch (template) {
    case "skill":
      return starterSkill(name ?? slug.replaceAll("-", " "));
    case "mcp-app":
      return example(TEMPLATE_FILES.converterManifest, name);
    case "kcal-diary":
      return example(TEMPLATE_FILES.diaryManifest, name);
  }
}

/** `manifest` with its file name replaced, keeping the directory exactly as it was written. */
function besideManifest(manifest: string, name: string): string {
  const base = path.basename(manifest);
  return base && manifest.endsWith(base)
    ? manifest.slice(0, manifest.length - base.length) + name
    : path.join(path.dirname(manifest), name);
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Writes a starter plugin: its manifest, and for the MCP app its server, page and README beside
 * it. Nothing is overwritten; when a file cannot be written, the files already created are
 * removed. Returns the paths created, as written relative to `cwd`.
 */
export async function scaffold(
  manifestPath: string,
  slug: string,
  name: string | undefined,
  template: Template,
  cwd: string,
): Promise<string[]> {
  checkSlug(slug);
  let manifestText: string;
  try {
    manifestText = registryManifestText(normalizeRegistryManifest(starter(template, slug, name)));
  } catch (error) {
    throw new CommandError(errorText(error), { cause: error });
  }
  const files: [string, string][] = [[manifestPath, manifestText]];
  if (template === "mcp-app") {
    files.push(
      [besideManifest(manifestPath, "server.ts"), TEMPLATE_FILES.converterServer],
      [besideManifest(manifestPath, "temperature.html"), TEMPLATE_FILES.converterPage],
      [besideManifest(manifestPath, "README.md"), TEMPLATE_FILES.converterReadme],
    );
  }
  const resolve = (file: string) => path.resolve(cwd, file);

  for (const [index, [file]] of files.entries()) {
    if (files.slice(0, index).some(([other]) => resolve(other) === resolve(file))) {
      throw new CommandError(`Multiple template files would use ${file}`);
    }
    try {
      await lstat(resolve(file));
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw withContext(`Checking ${file}`, error);
    }
    throw new CommandError(`${file} already exists`);
  }

  const created: string[] = [];
  for (const [file, text] of files) {
    try {
      const handle = await open(resolve(file), "wx");
      created.push(file);
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
    } catch (error) {
      let failure = withContext(`Creating ${file}`, error);
      for (const done of created.toReversed()) {
        try {
          await rm(resolve(done));
        } catch (cleanup) {
          failure = withContext(`Could not remove ${done}: ${errorText(cleanup)}`, failure);
        }
      }
      throw failure;
    }
  }
  return created;
}
