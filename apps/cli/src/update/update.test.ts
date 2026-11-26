import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/run-cli.js";
import { scriptedIo, testContext } from "../test/scripted-io.test-support.js";
import { installMethod, updateCommand } from "./install-method.js";
import type { UpdateEnvironment } from "./update-check.js";
import {
  CHECK_INTERVAL_MS,
  latestRelease,
  refreshUpdateCache,
  registryUrl,
} from "./update-check.js";
import { CLI_VERSION, compareVersions, isNewer } from "./version.js";

const NOW = Date.UTC(2026, 10, 26, 12);
const NPM_GLOBAL = "/usr/local/lib/node_modules/superbot-cli/dist/superbot.js";
const NOTICE =
  "superbot-cli 0.2.0 is available (you have 0.1.0). Update with: npm install -g superbot-cli@latest\n";

/** A registry that answers every request with `answer`, recording what was asked. */
function registry(answer: () => Promise<Response> | Response) {
  const requests: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    requests.push(String(url));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const published = (version: string) => () =>
  new Response(JSON.stringify({ name: "superbot-cli", version }), { status: 200 });

type Options = {
  terminal?: { stdoutIsTerminal?: boolean; stderrIsTerminal?: boolean };
  env?: Record<string, string>;
  updates?: UpdateEnvironment;
  cache?: unknown;
};

const atTerminal = { stdoutIsTerminal: true, stderrIsTerminal: true };

async function setup(options: Options = {}) {
  const context = await testContext(scriptedIo().io, { env: options.env });
  if (options.cache !== undefined) {
    await mkdir(context.directory, { recursive: true });
    await writeFile(
      path.join(context.directory, "update-check.json"),
      JSON.stringify(options.cache),
    );
  }
  const updates = {
    now: () => NOW,
    scriptPath: NPM_GLOBAL,
    version: "0.1.0",
    fetch: registry(published("0.1.0")).fetch,
    spawnCheck: vi.fn(),
    ...options.updates,
  };
  return async (argv: string[], terminal = options.terminal ?? atTerminal) => {
    const io = scriptedIo(terminal);
    const code = await runCli(argv, { ...context, io: io.io, updates });
    return { code, stdout: io.stdout(), stderr: io.stderr(), directory: context.directory };
  };
}

async function cacheOf(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(directory, "update-check.json"), "utf8"));
}

const knownNewer = { checkedAt: NOW - 60_000, latest: "0.2.0" };

describe("version precedence", () => {
  it("orders releases and prereleases the way semantic versioning does", () => {
    const ordered = [
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "10.0.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1);
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("never calls something that is not a version newer", () => {
    expect(compareVersions("latest", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0", "1.0.0")).toBeUndefined();
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.2.0-rc.1", "0.2.0")).toBe(false);
  });
});

describe("how the command was installed", () => {
  it("reads the package manager from where the script lives", () => {
    const cases: Array<[string, string]> = [
      [NPM_GLOBAL, "npm"],
      ["C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\superbot-cli\\dist\\superbot.js", "npm"],
      ["/home/a/.npm/_npx/1a2b3c/node_modules/superbot-cli/dist/superbot.js", "npx"],
      [
        "/home/a/.local/share/pnpm/global/5/.pnpm/superbot-cli@0.1.0/node_modules/superbot-cli/dist/superbot.js",
        "pnpm",
      ],
      [
        "/home/a/.cache/pnpm/dlx/abc/node_modules/.pnpm/superbot-cli@0.1.0/node_modules/superbot-cli/dist/superbot.js",
        "pnpm-dlx",
      ],
      ["/home/a/.bun/install/global/node_modules/superbot-cli/dist/superbot.js", "bun"],
      ["/home/a/.config/yarn/global/node_modules/superbot-cli/dist/superbot.js", "yarn"],
      ["/home/a/src/superbot/apps/cli/dist/superbot.js", "source"],
    ];
    for (const [script, method] of cases)
      expect([script, installMethod(script)]).toEqual([script, method]);
    expect(updateCommand("npm")).toBe("npm install -g superbot-cli@latest");
    expect(updateCommand("npx")).toBe("npx superbot-cli@latest");
    expect(updateCommand("source")).toBeUndefined();
  });
});

describe("the registry", () => {
  it("uses the registry npm passes to commands it runs, else npm's own", () => {
    expect(registryUrl({}).href).toBe("https://registry.npmjs.org/");
    expect(registryUrl({ npm_config_registry: "https://registry.example.test/npm" }).href).toBe(
      "https://registry.example.test/npm/",
    );
    expect(registryUrl({ npm_config_registry: "not a url" }).href).toBe(
      "https://registry.npmjs.org/",
    );
    expect(registryUrl({ npm_config_registry: "file:///tmp" }).href).toBe(
      "https://registry.npmjs.org/",
    );
  });

  it("reads the latest version and turns every failure into an answer", async () => {
    const ask = async (answer: () => Promise<Response> | Response, timeoutMs = 1000) => {
      const context = await testContext(scriptedIo().io);
      return latestRelease({ ...context, updates: { fetch: registry(answer).fetch } }, timeoutMs);
    };
    expect(await ask(published("0.3.0-beta.1"))).toEqual({
      kind: "found",
      version: "0.3.0-beta.1",
    });
    expect(await ask(() => new Response("Not found", { status: 404 }))).toEqual({
      kind: "unpublished",
    });
    expect(await ask(() => new Response("", { status: 503 }))).toEqual({ kind: "unreachable" });
    expect(await ask(() => new Response("<html>", { status: 200 }))).toEqual({
      kind: "unreachable",
    });
    expect(await ask(published("not-a-version"))).toEqual({ kind: "unreachable" });
    expect(
      await ask(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ kind: "unreachable" });
  });

  it("gives up when the registry does not answer in time", async () => {
    const context = await testContext(scriptedIo().io);
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    expect(await latestRelease({ ...context, updates: { fetch } }, 10)).toEqual({
      kind: "unreachable",
    });
  });
});

describe("the update notice", () => {
  it("follows a command on standard error when a newer release is known", async () => {
    const run = await setup({ cache: knownNewer });
    const result = await run(["server"]);
    expect(result).toMatchObject({
      code: 0,
      stdout: "http://127.0.0.1:5173/\n",
      stderr: NOTICE,
    });
  });

  it("follows --version, which prints only the version on standard output", async () => {
    const run = await setup({ cache: knownNewer });
    expect(await run(["--version"])).toMatchObject({
      code: 0,
      stdout: `superbot-cli ${CLI_VERSION}\n`,
      stderr: NOTICE,
    });
    expect(await run(["-V"], {})).toMatchObject({
      stdout: `superbot-cli ${CLI_VERSION}\n`,
      stderr: "",
    });
  });

  it("names the package manager that installed the command", async () => {
    const run = await setup({
      cache: knownNewer,
      updates: { scriptPath: "/home/a/.npm/_npx/1a/node_modules/superbot-cli/dist/superbot.js" },
    });
    expect((await run(["--version"])).stderr).toBe(
      "superbot-cli 0.2.0 is available (you have 0.1.0). Update with: npx superbot-cli@latest\n",
    );
  });

  it("stays quiet without a terminal, for JSON, in CI, when turned off, and for a source build", async () => {
    const quiet = async (options: Options, argv = ["--version"], terminal = atTerminal) => {
      // A stale check, so a command that may check would start one.
      const spawnCheck = vi.fn();
      const run = await setup({
        cache: { checkedAt: 1, latest: "0.2.0" },
        ...options,
        updates: { spawnCheck, ...options.updates },
      });
      const result = await run(argv, terminal);
      expect(result.stderr).toBe("");
      expect(spawnCheck).not.toHaveBeenCalled();
    };
    await quiet({}, ["--version"], { stdoutIsTerminal: false, stderrIsTerminal: true });
    await quiet({}, ["--version"], { stdoutIsTerminal: true, stderrIsTerminal: false });
    await quiet({}, ["server", "--json"]);
    await quiet({ env: { CI: "true" } });
    await quiet({ env: { NO_UPDATE_NOTIFIER: "1" } });
    await quiet({ env: { npm_config_update_notifier: "false" } });
    await quiet({ updates: { scriptPath: "/home/a/src/superbot/apps/cli/dist/superbot.js" } });
    // CI=false is not CI.
    const run = await setup({ cache: knownNewer, env: { CI: "false" } });
    expect((await run(["--version"])).stderr).toBe(NOTICE);
  });

  it("says nothing when the known release is not newer", async () => {
    const run = await setup({ cache: { checkedAt: NOW - 60_000, latest: "0.1.0" } });
    expect((await run(["--version"])).stderr).toBe("");
    const prerelease = await setup({ cache: { checkedAt: NOW - 60_000, latest: "0.1.0-rc.1" } });
    expect((await prerelease(["--version"])).stderr).toBe("");
  });
});

describe("the background check", () => {
  it("starts at most once a day, apart from the command, and its answer shows next time", async () => {
    const fetch = registry(published("0.2.0"));
    const spawnCheck = vi.fn();
    const run = await setup({ updates: { fetch: fetch.fetch, spawnCheck } });

    const first = await run(["--version"]);
    expect(first).toMatchObject({ code: 0, stdout: `superbot-cli ${CLI_VERSION}\n`, stderr: "" });
    expect(spawnCheck).toHaveBeenCalledTimes(1);
    expect(fetch.requests).toEqual([]);
    expect(await cacheOf(first.directory)).toEqual({ checkedAt: NOW });

    // What the started process runs.
    const context = await testContext(scriptedIo().io, {
      env: { SUPERBOT_CONFIG_DIR: first.directory },
    });
    await refreshUpdateCache({ ...context, updates: { fetch: fetch.fetch, now: () => NOW } });
    expect(fetch.requests).toEqual(["https://registry.npmjs.org/superbot-cli/latest"]);
    expect(await cacheOf(first.directory)).toEqual({ checkedAt: NOW, latest: "0.2.0" });

    expect((await run(["--version"])).stderr).toBe(NOTICE);
    expect((await run(["server"])).stderr).toBe(NOTICE);
    expect(spawnCheck).toHaveBeenCalledTimes(1);
  });

  it("checks again once the last check is a day old, or dated in the future", async () => {
    for (const checkedAt of [NOW - CHECK_INTERVAL_MS, NOW + 60_000]) {
      const spawnCheck = vi.fn();
      const run = await setup({ cache: { checkedAt, latest: "0.2.0" }, updates: { spawnCheck } });
      // The last known release is still mentioned while the new check runs.
      const result = await run(["--version"]);
      expect(result.stderr).toBe(NOTICE);
      expect(spawnCheck).toHaveBeenCalledTimes(1);
      expect(await cacheOf(result.directory)).toEqual({ checkedAt: NOW, latest: "0.2.0" });
    }
  });

  it("keeps the release it knew when the registry fails, and forgets it once unpublished", async () => {
    const check = async (answer: () => Response) => {
      const context = await testContext(scriptedIo().io);
      await mkdir(context.directory, { recursive: true });
      await writeFile(
        path.join(context.directory, "update-check.json"),
        JSON.stringify({ checkedAt: 1, latest: "0.2.0" }),
      );
      await refreshUpdateCache({
        ...context,
        updates: { fetch: registry(answer).fetch, now: () => NOW },
      });
      return cacheOf(context.directory);
    };
    expect(
      await check(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ checkedAt: NOW, latest: "0.2.0" });
    expect(await check(() => new Response("{", { status: 200 }))).toEqual({
      checkedAt: NOW,
      latest: "0.2.0",
    });
    expect(await check(() => new Response("", { status: 404 }))).toEqual({ checkedAt: NOW });
  });

  it("ignores an unreadable cache, and starts nothing when it cannot record the attempt", async () => {
    const garbage = await setup({ cache: "not an object" });
    expect(await garbage(["--version"])).toMatchObject({ code: 0, stderr: "" });

    const blocker = await testContext(scriptedIo().io);
    await mkdir(path.dirname(blocker.directory), { recursive: true });
    await writeFile(blocker.directory, "a file where the settings folder should be");
    const spawnCheck = vi.fn();
    const run = await setup({
      env: { SUPERBOT_CONFIG_DIR: blocker.directory },
      updates: { spawnCheck },
    });
    expect(await run(["--version"])).toMatchObject({ code: 0, stderr: "" });
    expect(spawnCheck).not.toHaveBeenCalled();
  });
});

describe("superbot update", () => {
  it("says when this is the latest release", async () => {
    const run = await setup();
    expect(await run(["update"], {})).toEqual(
      expect.objectContaining({
        code: 0,
        stdout: "superbot-cli 0.1.0 is up to date.\n",
        stderr: "",
      }),
    );
  });

  it("prints the command for this install, records the answer, and checks only once", async () => {
    const fetch = registry(published("0.2.0"));
    const run = await setup({
      env: { npm_config_registry: "https://registry.example.test/" },
      updates: {
        fetch: fetch.fetch,
        scriptPath:
          "/home/a/.local/share/pnpm/global/5/.pnpm/superbot-cli@0.1.0/node_modules/superbot-cli/dist/superbot.js",
      },
    });
    const result = await run(["update"]);
    expect(result).toMatchObject({
      code: 0,
      stdout:
        "superbot-cli 0.2.0 is available (you have 0.1.0).\nUpdate with: pnpm add -g superbot-cli@latest\n",
      stderr: "",
    });
    expect(fetch.requests).toEqual(["https://registry.example.test/superbot-cli/latest"]);
    expect(
      JSON.parse(await readFile(path.join(result.directory, "update-check.json"), "utf8")),
    ).toEqual({ checkedAt: NOW, latest: "0.2.0" });
  });

  it("prints JSON, even in CI", async () => {
    const run = await setup({
      env: { CI: "1" },
      updates: { fetch: registry(published("0.2.0")).fetch },
    });
    const result = await run(["update", "--json"], {});
    expect(JSON.parse(result.stdout)).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      updateAvailable: true,
      command: "npm install -g superbot-cli@latest",
    });
  });

  it("points a source build at rebuilding or installing", async () => {
    const run = await setup({
      updates: {
        fetch: registry(published("0.2.0")).fetch,
        scriptPath: "/home/a/src/superbot/apps/cli/dist/superbot.js",
      },
    });
    expect((await run(["update"])).stdout).toBe(
      "superbot-cli 0.2.0 is available (you have 0.1.0).\nThis copy was built from source: pull and rebuild it, or install it with:\n  npm install -g superbot-cli@latest\n",
    );
  });

  it("explains when it cannot tell", async () => {
    const unpublished = await setup({
      updates: { fetch: registry(() => new Response("", { status: 404 })).fetch },
    });
    expect(await unpublished(["update"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "superbot: superbot-cli is not on the npm registry yet\n",
    });
    const offline = await setup({
      updates: {
        fetch: registry(() => {
          throw new TypeError("fetch failed");
        }).fetch,
      },
    });
    expect(await offline(["update"])).toMatchObject({
      code: 1,
      stderr: "superbot: Could not check for updates: registry.npmjs.org did not answer\n",
    });
  });
});
