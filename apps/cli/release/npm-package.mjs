#!/usr/bin/env node
// Builds the folder that npm publishes as `superbot-cli`, and checks what a tarball of it holds.
//
// apps/cli/package.json stays private: it names workspace packages npm cannot install. The
// published manifest is generated here instead, from the same file, with the workspace packages
// left out because the bundle already contains them. Only modules the build keeps external remain
// as dependencies, so `npm install superbot-cli` needs nothing from this repository.
//
//   node release/npm-package.mjs stage <folder>    build and write the package folder
//   node release/npm-package.mjs verify <folder>   pack it (dry run) and check the contents
//   node release/npm-package.mjs release-tag <file> the dist-tag for this version, given the
//                                                   versions already published (npm view --json)
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildCli, cliBuildOptions } from "../build.mjs";
import { compareVersions, isVersion } from "../src/update/version.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const repoRoot = path.resolve(cliRoot, "../..");

/** Every file the tarball holds; anything else is a mistake. */
export const PACKED_FILES = [
  "LICENSE",
  "README.md",
  "bin/superbot.js",
  "dist/superbot.js",
  "package.json",
];

/** Fields copied from apps/cli/package.json into the published manifest as they are. */
const COPIED = [
  "name",
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "repository",
  "license",
  "type",
  "bin",
  "engines",
  "files",
  "publishConfig",
];

/** The manifest npm publishes: no scripts, no dev tooling, and only the external modules. */
export function publishManifest(source, external = cliBuildOptions().external) {
  const manifest = {};
  for (const field of COPIED) {
    if (source[field] !== undefined) manifest[field] = source[field];
  }
  manifest.dependencies = Object.fromEntries(
    external.map((name) => {
      const version = source.dependencies?.[name];
      if (!version) throw new Error(`${name} is external to the bundle but not a dependency`);
      return [name, version];
    }),
  );
  return manifest;
}

/** Problems with a manifest about to be published; empty when it is fine. */
export function manifestProblems(manifest) {
  const problems = [];
  if (manifest.name !== "superbot-cli") problems.push(`name is ${manifest.name}`);
  if (manifest.private !== undefined) problems.push("private is set");
  if (manifest.scripts !== undefined) problems.push("it runs install or publish scripts");
  if (manifest.devDependencies !== undefined) problems.push("it lists devDependencies");
  if (manifest.bin?.superbot !== "./bin/superbot.js") problems.push("bin superbot is missing");
  if (manifest.publishConfig?.access !== "public")
    problems.push("publishConfig.access is not public");
  if (manifest.publishConfig?.provenance !== true) problems.push("provenance is not required");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|link|file|catalog):/.test(String(version))) {
        problems.push(`${field} ${name} uses ${version}`);
      }
      if (name.startsWith("@rakazo/")) problems.push(`${field} names workspace package ${name}`);
    }
  }
  return problems;
}

/** Problems with the list of packed files; empty when it is exactly the expected set. */
export function packedFileProblems(files) {
  const packed = [...files].sort();
  const missing = PACKED_FILES.filter((file) => !packed.includes(file));
  const extra = packed.filter((file) => !PACKED_FILES.includes(file));
  return [
    ...missing.map((file) => `${file} is missing`),
    ...extra.map((file) => `${file} should not be published`),
  ];
}

/** Writes the publishable folder: the bundle, its launcher, the readme, licence and manifest. */
export async function stagePackage(folder) {
  const source = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
  await rm(folder, { recursive: true, force: true });
  await mkdir(path.join(folder, "bin"), { recursive: true });
  await buildCli(path.join(folder, "dist", "superbot.js"));
  await copyFile(path.join(cliRoot, "bin", "superbot.js"), path.join(folder, "bin", "superbot.js"));
  await copyFile(path.join(cliRoot, "README.md"), path.join(folder, "README.md"));
  await copyFile(path.join(repoRoot, "LICENSE"), path.join(folder, "LICENSE"));
  await writeFile(
    path.join(folder, "package.json"),
    `${JSON.stringify(publishManifest(source), null, 2)}\n`,
  );
}

/** Packs the folder without writing a tarball and returns every problem found. */
export async function verifyPackage(folder) {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json"], {
    cwd: folder,
    shell: process.platform === "win32",
  });
  const [packed] = JSON.parse(stdout);
  const manifest = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"));
  const bundle = await readFile(path.join(folder, "dist", "superbot.js"), "utf8");
  const problems = [
    ...manifestProblems(manifest),
    ...packedFileProblems(packed.files.map((file) => file.path)),
  ];
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    problems.push(`npm packs ${packed.name}@${packed.version}`);
  }
  // A build machine's own folders have no place in a published file.
  if (/(?:\/home\/|\/Users\/|[A-Z]:\\\\Users\\\\)[^"'\s]/.test(bundle)) {
    problems.push("the bundle contains an absolute path from the build machine");
  }
  return problems;
}

/**
 * The CLI keeps its own version, apart from the app release tags: a release publishes whatever
 * apps/cli/package.json says, once, and only when it is newer than every release already out. A
 * prerelease goes to the `next` tag so `npm install superbot-cli` keeps the last stable one.
 */
export function releaseTag(version, published) {
  if (!isVersion(version)) throw new Error(`${version} is not a version`);
  if (published.includes(version)) {
    throw new Error(
      `superbot-cli ${version} is already on npm; raise the version in apps/cli/package.json`,
    );
  }
  const newest = published
    .filter(isVersion)
    .sort((a, b) => compareVersions(a, b))
    .at(-1);
  if (newest && compareVersions(version, newest) <= 0) {
    throw new Error(`superbot-cli ${version} is not newer than ${newest}, already on npm`);
  }
  return version.includes("-") ? "next" : "latest";
}

/** What `npm view superbot-cli versions --json` printed: one version, a list, or nothing yet. */
export function publishedVersions(text) {
  if (text.trim() === "") return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, folder] = process.argv.slice(2);
  if (!folder || !["stage", "verify", "release-tag"].includes(command)) {
    process.stderr.write("Usage: node release/npm-package.mjs stage|verify|release-tag <path>\n");
    process.exit(2);
  }
  const target = path.resolve(folder);
  if (command === "release-tag") {
    const source = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
    try {
      const published = publishedVersions(await readFile(target, "utf8"));
      process.stdout.write(`${releaseTag(source.version, published)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  } else if (command === "stage") {
    await stagePackage(target);
  } else {
    const problems = await verifyPackage(target);
    if (problems.length > 0) {
      process.stderr.write(`The superbot-cli package is not ready:\n- ${problems.join("\n- ")}\n`);
      process.exit(1);
    }
    process.stdout.write("The superbot-cli package holds exactly what it should.\n");
  }
}
