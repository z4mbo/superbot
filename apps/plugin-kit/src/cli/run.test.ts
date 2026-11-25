import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemCredentialStore } from "@rakazo/cli-client";
import { afterEach, describe, expect, it } from "vitest";
import type { Exchange } from "../registry/registry-fixture.test-support.js";
import { useRegistryFixture } from "../registry/registry-fixture.test-support.js";
import { run } from "./run.js";

const fixture = useRegistryFixture();
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A credential store holding one session per server origin; it never reaches the system's. */
function fakeStore(sessions: Record<string, string>): SystemCredentialStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async get(_service, account) {
      reads.push(account);
      return sessions[account] ?? null;
    },
    async set() {
      throw new Error("The plugin tool never saves a session");
    },
    async delete() {
      throw new Error("The plugin tool never deletes a session");
    },
  };
}

/** Runs the command line against a temporary settings folder and records its output. */
async function invoke(
  argv: string[],
  options: { store?: SystemCredentialStore; env?: Record<string, string> } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "superbot-plugin-run-"));
  directories.push(root);
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: { SUPERBOT_CONFIG_DIR: path.join(root, "settings"), ...options.env },
    cwd: root,
    systemStore: options.store ?? fakeStore({}),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const SPACES: Exchange[] = [
  {
    procedure: "spaces/list",
    response: { spaces: [{ id: "space-1", name: "Personal" }] },
  },
  {
    procedure: "organizations/list",
    response: { activeOrganizationId: "org-1", organizations: [] },
  },
];

describe("run", () => {
  it("prints the registry's answer as indented JSON in the only Space", async () => {
    const server = await fixture([
      ...SPACES,
      {
        procedure: "pluginRegistry/install",
        input: { versionId: "version" },
        response: { id: "install", grants: [] },
      },
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    const result = await invoke(["--server", server.origin, "install", "version"], { store });
    expect(result).toEqual({
      code: 0,
      stdout: '{\n  "id": "install",\n  "grants": []\n}\n',
      stderr: "",
    });
    expect(store.reads).toEqual([`${server.origin}/`]);
    expect(server.calls.at(-1)?.headers).toMatchObject({
      authorization: "Bearer fixture.signed",
      "x-rakazo-space-id": "space-1",
    });
  });

  it("takes the server from SUPERBOT_SERVER and the Space from --space after the command", async () => {
    const server = await fixture([
      {
        procedure: "spaces/list",
        response: {
          spaces: [
            { id: "space-1", name: "Personal" },
            { id: "space-2", name: "Team" },
          ],
        },
      },
      SPACES[1] as Exchange,
      {
        procedure: "pluginRegistry/uninstall",
        input: { installationId: "i" },
        response: { ok: true },
      },
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    const result = await invoke(["uninstall", "i", "--space", "Team"], {
      store,
      env: { SUPERBOT_SERVER: server.origin },
    });
    expect(result.stdout).toBe('{\n  "ok": true\n}\n');
    expect(server.calls.at(-1)?.headers["x-rakazo-space-id"]).toBe("space-2");
  });

  it("asks for a sign-in when no session is saved", async () => {
    const server = await fixture([]);
    expect(await invoke(["--server", server.origin, "agents"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Error: No saved session for this server. Run superbot login for the same server\n",
    });
    expect(server.calls).toEqual([]);
  });

  it("says how to sign in again when the server rejects the session", async () => {
    const server = await fixture([
      {
        procedure: "spaces/list",
        response: { defined: false, code: "UNAUTHORIZED", status: 401, message: "Unauthorized" },
        status: 401,
      },
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    expect(await invoke(["--server", server.origin, "agents"], { store })).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "Error: Session expired or rejected. Run superbot login for the same server: Superbot returned HTTP 401: Unauthorized\n",
    });
  });

  it("says how to sign in again when a registry call is refused as unauthorized", async () => {
    const server = await fixture([
      ...SPACES,
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50 },
        response: { defined: false, code: "UNAUTHORIZED", status: 401, message: "Expired" },
        status: 401,
      },
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    const result = await invoke(["--server", server.origin, "status", "v"], { store });
    expect(result.stderr).toBe(
      "Error: Session expired or rejected. Run superbot login for the same server: Superbot returned HTTP 401: Expired\n",
    );
  });

  it("escapes a server's message so it cannot drive the terminal", async () => {
    const server = await fixture([
      ...SPACES,
      {
        procedure: "pluginRegistry/install",
        input: { versionId: "v" },
        response: { code: "CONFLICT", status: 409, message: 'Can\'t\n\u001b[2Jinstall "it"' },
        status: 409,
      },
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    const result = await invoke(["--server", server.origin, "install", "v"], { store });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'Error: Superbot returned HTTP 409: Can\\\'t\\n\\u{1b}[2Jinstall \\"it\\"\n',
    );
  });

  it("lists the Spaces to choose from", async () => {
    const server = await fixture([
      {
        procedure: "spaces/list",
        response: {
          spaces: [
            { id: "space-1", name: "Personal" },
            { id: "space-2", name: "Team" },
          ],
        },
      },
      SPACES[1] as Exchange,
    ]);
    const store = fakeStore({ [`${server.origin}/`]: "fixture.signed" });
    expect((await invoke(["--server", server.origin, "agents"], { store })).stderr).toBe(
      'Error: Select a Space with --space. Available Spaces: \\"Personal\\" (space-1), \\"Team\\" (space-2)\n',
    );
  });

  it("refuses an invalid server before reading any session", async () => {
    const store = fakeStore({});
    const result = await invoke(["--server", "http://example.test", "agents"], { store });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "Error: Use an HTTPS Superbot origin or a local HTTP origin such as http://127.0.0.1:3000\n",
    );
    expect(store.reads).toEqual([]);
  });

  it("checks arguments before contacting the server", async () => {
    const store = fakeStore({});
    const result = await invoke(["--server", "http://127.0.0.1:9", "grant", "i", "b", "Bad"], {
      store,
    });
    expect(result.stderr).toBe(
      "Error: Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens\n",
    );
    expect(store.reads).toEqual([]);
  });

  it("reports a missing manifest with the system's words", async () => {
    const result = await invoke(["validate", "missing.json"]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        process.platform === "win32"
          ? expect.stringMatching(/^Error: Reading registry manifest missing\.json: /)
          : "Error: Reading registry manifest missing.json: No such file or directory (os error 2)\n",
    });
  });

  it("prints usage errors with exit status 2 and help with 0", async () => {
    expect(await invoke(["publish", "x", "0"])).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "error: invalid value '0' for '<VERSION>': 0 is not in 1..=2147483647\n\nFor more information, try '--help'.\n",
    });
    const help = await invoke(["--version"]);
    expect(help).toEqual({ code: 0, stdout: "superbot-plugin-kit 0.1.0\n", stderr: "" });
  });
});
