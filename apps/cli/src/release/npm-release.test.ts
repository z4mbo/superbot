import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const cliPackage = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(cliPackage, "release", "npm-package.mjs");
const workflow = await readFile(
  path.join(cliPackage, "../../.github/workflows/release-cli.yml"),
  "utf8",
);

const packageScript = (args: string[]) =>
  run(process.execPath, [script, ...args], { cwd: cliPackage });

/** The packaging script and workflow that publish superbot-cli to npm; nothing here publishes. */
describe("the npm package", { timeout: 120_000 }, () => {
  let scratch: string;
  let folder: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "superbot-npm-"));
    folder = path.join(scratch, "package");
    await packageScript(["stage", folder]);
  }, 120_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("holds only the bundle, its launcher, readme, licence and a standalone manifest", async () => {
    const verified = await packageScript(["verify", folder]);
    expect(verified.stdout).toBe("The superbot-cli package holds exactly what it should.\n");
    const manifest = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"));
    const source = JSON.parse(await readFile(path.join(cliPackage, "package.json"), "utf8"));
    expect(source.private).toBe(true);
    expect(manifest).toMatchObject({
      name: "superbot-cli",
      version: source.version,
      bin: { superbot: "./bin/superbot.js" },
      repository: { url: "git+https://github.com/z4mbo/superbot.git", directory: "apps/cli" },
      publishConfig: { access: "public", provenance: true },
      dependencies: { "@napi-rs/keyring": source.dependencies["@napi-rs/keyring"] },
    });
    expect(Object.keys(manifest.dependencies)).toEqual(["@napi-rs/keyring"]);
    expect(manifest).not.toHaveProperty("private");
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("devDependencies");
  });

  it("refuses a package that names workspace packages or carries extra files", async () => {
    const manifestFile = path.join(folder, "package.json");
    const manifest = await readFile(manifestFile, "utf8");
    const parsed = JSON.parse(manifest);
    await writeFile(
      manifestFile,
      JSON.stringify({
        ...parsed,
        private: true,
        files: [...parsed.files, "secrets.txt"],
        dependencies: { ...parsed.dependencies, "@rakazo/core": "workspace:*" },
      }),
    );
    await writeFile(path.join(folder, "secrets.txt"), "placeholder");
    try {
      const failed = packageScript(["verify", folder]);
      await expect(failed).rejects.toMatchObject({ code: 1 });
      const { stderr } = await failed.catch((error: { stderr: string }) => error);
      expect(stderr).toContain("private is set");
      expect(stderr).toContain("dependencies @rakazo/core uses workspace:*");
      expect(stderr).toContain("secrets.txt should not be published");
    } finally {
      await writeFile(manifestFile, manifest);
      await rm(path.join(folder, "secrets.txt"));
    }
  });

  it("publishes a version only when it is new and newer than every release out", async () => {
    const source = JSON.parse(await readFile(path.join(cliPackage, "package.json"), "utf8"));
    const tagFor = async (published: string) => {
      const file = path.join(scratch, "published.json");
      await writeFile(file, published);
      return packageScript(["release-tag", file]);
    };
    expect((await tagFor("")).stdout).toBe("latest\n");
    expect((await tagFor('"0.0.1"')).stdout).toBe("latest\n");
    expect((await tagFor('["0.0.1", "0.0.2-rc.1"]')).stdout).toBe("latest\n");
    await expect(tagFor(JSON.stringify([source.version]))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already on npm"),
    });
    await expect(tagFor('["999.0.0"]')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("is not newer than 999.0.0"),
    });
  });
});

describe("the CLI version", () => {
  it("is the app's release version, which the release tag names", async () => {
    const cli = JSON.parse(await readFile(path.join(cliPackage, "package.json"), "utf8"));
    const desktop = JSON.parse(
      await readFile(path.join(cliPackage, "../desktop/package.json"), "utf8"),
    );
    expect(cli.version).toBe(desktop.version);
  });
});

describe("the CLI release workflow", () => {
  it("publishes from a release tag on main, and otherwise only when asked from one", () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^\s*(?:pull_request|pull_request_target|schedule):/m);
    expect(workflow).not.toMatch(/^\s*branches:/m);
    expect(workflow).toContain("permissions:\n  contents: read\n");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain(
      "if: github.ref_type == 'tag' && (github.event_name == 'push' || inputs.publish)",
    );
    expect(workflow).toContain('"$RELEASE_TAG" != "v$version"');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it("skips publishing a tag run until the first release has a credential", () => {
    expect(workflow).toContain("::notice title=superbot-cli not published::");
    expect(workflow).toMatch(
      /if \[\[ "\$MANUAL" == "true" \]\]; then\n\s+echo "\$message" >&2\n\s+exit 1/,
    );
  });

  it("grants publishing rights only to the publish job", () => {
    const [, publishJob = ""] = workflow.split(/^ {2}publish:\n/m);
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(publishJob).toContain("id-token: write");
    expect(workflow.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    expect(publishJob).toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toMatch(/echo[^\n]*\$\{?NPM_TOKEN/);
    expect(publishJob).toContain("--provenance");
    expect(publishJob).toContain("needs: package");
  });

  it("checks the package before anything is published", () => {
    for (const step of [
      "pnpm --filter superbot-cli check",
      "pnpm --filter superbot-cli test",
      "pnpm --filter superbot-cli pack:npm",
      "npm-package.mjs release-tag",
      '"$RUNNER_TEMP/prefix/bin/superbot" --version',
    ]) {
      expect(workflow).toContain(step);
    }
    expect(workflow).toContain("persist-credentials: false");
  });

  it("pins every action to an immutable commit", () => {
    const references = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      if (reference?.startsWith("./")) continue;
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
