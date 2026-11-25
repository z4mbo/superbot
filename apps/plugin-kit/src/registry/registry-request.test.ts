import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Space } from "@rakazo/cli-client";
import { Client, SuperbotError } from "@rakazo/cli-client";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommandLine } from "../cli/arguments.js";
import { readManifestFile } from "../manifest/manifest-file.js";
import { scaffold } from "../scaffold/scaffold.js";
import type { Exchange } from "./registry-fixture.test-support.js";
import { useRegistryFixture } from "./registry-fixture.test-support.js";
import { registryRequest, selectSpace } from "./registry-request.js";

const fixture = useRegistryFixture();
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "superbot-plugin-"));
  directories.push(directory);
  return directory;
}

/** Parses a command line, builds its request and runs it against the fixture's Space. */
async function execute(client: Client, args: string[], cwd = process.cwd()): Promise<unknown> {
  const parsed = parseCommandLine(args, {});
  if ("code" in parsed) throw new Error(parsed.stderr);
  const { command } = parsed;
  if (command.kind === "init" || command.kind === "validate") throw new Error("a local command");
  return (await registryRequest(command, cwd))(client, "fixture-space");
}

/** Serves the exchanges and checks every call carried the session, the Space and its input. */
async function registry(exchanges: Exchange[]) {
  const server = await fixture(exchanges);
  const client = new Client(server.origin).withToken("fixture.signed");
  const verify = () => {
    expect(server.pending()).toBe(0);
    expect(server.calls).toHaveLength(exchanges.length);
    for (const [index, call] of server.calls.entries()) {
      const exchange = exchanges[index] as Exchange;
      expect(call.method).toBe("POST");
      expect(call.path).toBe(`/rpc/${exchange.procedure}`);
      expect(call.headers.authorization).toBe("Bearer fixture.signed");
      expect(call.headers["x-rakazo-space-id"]).toBe("fixture-space");
      expect(call.input).toEqual(exchange.input);
    }
  };
  return { client, verify };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );
}

describe("registry commands", () => {
  it("submit sends the validated manifest and accepts the registry's version range", async () => {
    const cwd = await temporaryDirectory();
    await scaffold("plugin.json", "release-notes", undefined, "skill", cwd);
    const manifest = await readManifestFile("plugin.json", cwd);
    const response = { id: "version", status: "pending" };
    const { client, verify } = await registry([
      {
        procedure: "pluginRegistry/submit",
        input: { slug: "release-notes", version: 2147483647, manifest },
        response,
      },
    ]);
    expect(
      await execute(client, [
        "submit",
        "release-notes",
        "2147483647",
        "--manifest",
        path.join(cwd, "plugin.json"),
      ]),
    ).toEqual(response);
    verify();
    for (const version of ["0", "2147483648"]) {
      expect(parseCommandLine(["publish", "release-notes", version], {})).toMatchObject({
        code: 2,
      });
    }
  });

  it("status follows the publisher's cursors", async () => {
    const release = { id: "version", slug: "release-notes", status: "pending" };
    const { client, verify } = await registry([
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50 },
        response: { items: [], nextAfter: "opaque" },
      },
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50, after: "opaque" },
        response: { items: [release], nextAfter: null },
      },
    ]);
    expect(await execute(client, ["status", "version"])).toEqual(release);
    verify();
  });

  it("status reports a missing version and a repeated cursor", async () => {
    const missing = await registry([
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50 },
        response: { items: [{ id: "other" }], nextAfter: null },
      },
    ]);
    expect(await rejection(execute(missing.client, ["status", "version"]))).toMatchObject({
      message: "No submitted version with ID version",
    });
    missing.verify();

    const looping = await registry([
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50 },
        response: { items: [], nextAfter: "same" },
      },
      {
        procedure: "pluginRegistry/mine",
        input: { limit: 50, after: "same" },
        response: { items: [], nextAfter: "same" },
      },
    ]);
    expect(await rejection(execute(looping.client, ["status", "version"]))).toMatchObject({
      message: "Registry repeated the pagination cursor",
    });
    looping.verify();
  });

  it("grants and review use the registry wire and the server's authorization", async () => {
    const { client, verify } = await registry([
      {
        procedure: "pluginRegistry/setGrants",
        input: { installationId: "install", botId: "bot", partIds: ["summary"] },
        response: { id: "install", grants: [{ botId: "bot", partId: "summary" }] },
      },
      {
        procedure: "pluginRegistry/setGrants",
        input: { installationId: "install", botId: "bot", partIds: [] },
        response: { id: "install", grants: [] },
      },
      {
        procedure: "pluginRegistry/review",
        input: { versionId: "version", decision: "rejected", reason: "Needs edits" },
        response: {
          defined: false,
          code: "FORBIDDEN",
          message: "Admin access required",
          status: 403,
        },
        status: 403,
      },
    ]);
    const granted = (await execute(client, ["grant", "install", "bot", "summary"])) as {
      grants: { partId: string }[];
    };
    expect(granted.grants[0]?.partId).toBe("summary");
    expect(await execute(client, ["grant", "install", "bot"])).toEqual({
      id: "install",
      grants: [],
    });
    const error = await rejection(
      execute(client, ["review", "version", "rejected", "--reason", " Needs edits "]),
    );
    expect(error).toBeInstanceOf(SuperbotError);
    expect(error).toMatchObject({ kind: "server", status: 403 });
    expect((error as Error).message).toBe("Superbot returned HTTP 403: Admin access required");
    verify();
  });

  it("list, review, install, switch-version and uninstall use the registry routes", async () => {
    const page = { items: [], nextAfter: "more" };
    const cases: [string[], Exchange][] = [
      [
        [
          "list",
          "discover",
          "--slug",
          "release-notes",
          "--query",
          "  release notes  ",
          "--after",
          "cursor",
          "--limit",
          "7",
        ],
        {
          procedure: "pluginRegistry/discover",
          input: { slug: "release-notes", query: "release notes", after: "cursor", limit: 7 },
          response: page,
        },
      ],
      [
        ["list", "submissions", "--status", "approved"],
        {
          procedure: "pluginRegistry/submissions",
          input: { status: "approved", limit: 20 },
          response: page,
        },
      ],
      [
        ["review", "version", "approved"],
        {
          procedure: "pluginRegistry/review",
          input: { versionId: "version", decision: "approved" },
          response: { status: "approved" },
        },
      ],
      [
        ["install", "version"],
        {
          procedure: "pluginRegistry/install",
          input: { versionId: "version" },
          response: { id: "install", grants: [] },
        },
      ],
      [
        ["switch-version", "install", "old-version", "new-version"],
        {
          procedure: "pluginRegistry/switchVersion",
          input: {
            installationId: "install",
            expectedVersionId: "old-version",
            versionId: "new-version",
          },
          response: { id: "install", grants: [] },
        },
      ],
      [
        ["list", "installations"],
        { procedure: "pluginRegistry/installations", input: { limit: 20 }, response: page },
      ],
      [
        ["list", "mine"],
        { procedure: "pluginRegistry/mine", input: { limit: 20 }, response: page },
      ],
      [["list"], { procedure: "pluginRegistry/discover", input: { limit: 20 }, response: page }],
      [
        ["uninstall", "install"],
        {
          procedure: "pluginRegistry/uninstall",
          input: { installationId: "install" },
          response: { ok: true },
        },
      ],
    ];
    const { client, verify } = await registry(cases.map(([, exchange]) => exchange));
    for (const [args, exchange] of cases) {
      expect(await execute(client, args)).toEqual(exchange.response);
    }
    verify();
  });

  it("agents lists each agent's ID and name only", async () => {
    const server = await fixture([
      {
        procedure: "bots/list",
        response: [{ id: "bot-1", name: "Research", color: "#000000", extra: true }],
      },
    ]);
    const client = new Client(server.origin).withToken("fixture.signed");
    expect(await execute(client, ["agents"])).toEqual([{ id: "bot-1", name: "Research" }]);
    expect(server.calls[0]?.headers["x-rakazo-space-id"]).toBe("fixture-space");
  });

  it("refuses arguments the registry would refuse before sending anything", async () => {
    const offline = new Client("http://127.0.0.1:9").withToken("fixture.signed");
    for (const [args, message] of [
      [["list", "mine", "--query", "test"], "--query requires list discover"],
      [
        ["list", "discover", "--query", " "],
        "query must contain 1 to 120 UTF-16 code units after trimming",
      ],
      [
        ["list", "discover", "--query", "x".repeat(121)],
        "query must contain 1 to 120 UTF-16 code units after trimming",
      ],
      [["list", "installations", "--slug", "x"], "--slug requires list discover"],
      [["list", "discover", "--status", "pending"], "--status requires list submissions"],
      [
        ["list", "discover", "--slug", "Not-A-Slug"],
        "Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens",
      ],
      [["review", "v", "approved", "--reason", "x"], "--reason is only used for rejection"],
      [
        ["review", "v", "rejected", "--reason", " "],
        "reason must contain 1 to 2000 UTF-16 code units after trimming",
      ],
      [
        ["grant", "i", "b", "BAD"],
        "Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens",
      ],
      [
        ["grant", "i", "b", ...Array.from({ length: 17 }, (_, n) => `p${n}`)],
        "Supply at most 16 part IDs",
      ],
      [
        ["publish", "BAD", "1"],
        "Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens",
      ],
    ] as const) {
      expect(await rejection(execute(offline, [...args]))).toMatchObject({ message });
    }
  });

  it("names the manifest it could not read", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(path.join(cwd, "plugin.json"), "{}");
    const offline = new Client("http://127.0.0.1:9").withToken("fixture.signed");
    expect(await rejection(execute(offline, ["publish", "ok", "1"], cwd))).toMatchObject({
      message: "Reading registry manifest plugin.json: schemaVersion: “schemaVersion” is missing.",
    });
  });
});

describe("selectSpace", () => {
  const spaces = [
    { id: "first", name: "Shared" },
    { id: "second", name: "Shared" },
  ] as Space[];

  it("refuses ambiguity and accepts IDs", () => {
    expect(() => selectSpace(spaces, undefined)).toThrow(
      'Select a Space with --space. Available Spaces: "Shared" (first), "Shared" (second)',
    );
    expect(() => selectSpace(spaces, "Shared")).toThrow(
      'Multiple Spaces match "Shared". Use a Space ID',
    );
    expect(selectSpace(spaces, "second").id).toBe("second");
    expect(selectSpace(spaces.slice(0, 1), undefined).id).toBe("first");
  });

  it("names a missing Space and the need to join one", () => {
    expect(() => selectSpace(spaces, "Team\n")).toThrow('No Space matches "Team\\n"');
    expect(() => selectSpace([], undefined)).toThrow("Join or create a Space in Superbot first");
  });
});
