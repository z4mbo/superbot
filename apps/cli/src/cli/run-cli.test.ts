import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@rakazo/cli-client";
import { describe, expect, it } from "vitest";
import { rosterKey } from "../commands/import-bots.js";
import type { Exchange } from "../test/loopback.test-support.js";
import {
  authOk,
  card,
  discovery,
  event,
  events,
  loopback,
  me,
  refused,
  rpc,
  signIn,
  snapshot,
} from "../test/loopback.test-support.js";
import { memoryStore, scriptedIo, testContext } from "../test/scripted-io.test-support.js";
import { runCli } from "./run-cli.js";

type Terminal = Parameters<typeof scriptedIo>[0];

async function cli(
  argv: string[],
  options: {
    terminal?: Terminal;
    env?: Record<string, string>;
    store?: ReturnType<typeof memoryStore>;
    token?: { origin: string; value?: string };
  } = {},
) {
  const terminal = scriptedIo(options.terminal);
  const store = options.store ?? memoryStore();
  const context = await testContext(terminal.io, { systemStore: store.store, env: options.env });
  if (options.token) {
    await context.credentials.save(
      new Client(options.token.origin).withToken(options.token.value ?? "fixture.signed"),
    );
  }
  const code = await runCli(argv, context);
  return { code, stdout: terminal.stdout(), stderr: terminal.stderr(), context, store };
}

/** A context that keeps its settings between commands, as one device does. */
async function device(env: Record<string, string> = {}) {
  const store = memoryStore();
  const first = scriptedIo();
  const context = await testContext(first.io, { systemStore: store.store, env });
  return async (argv: string[], terminal: Terminal = {}) => {
    const io = scriptedIo(terminal);
    const code = await runCli(argv, { ...context, io: io.io });
    return { code, stdout: io.stdout(), stderr: io.stderr() };
  };
}

describe("server selection", () => {
  it("prefers --server, then SUPERBOT_SERVER, then the saved server, then the local default", async () => {
    const run = await device();
    expect(await run(["server"])).toEqual({
      code: 0,
      stdout: "http://127.0.0.1:5173/\n",
      stderr: "",
    });
    expect((await run(["server", " https://saved.example.test "])).stdout).toBe(
      "https://saved.example.test/\n",
    );
    expect((await run(["server"])).stdout).toBe("https://saved.example.test/\n");
    expect((await run(["--server", "https://flag.example.test", "server"])).stdout).toBe(
      "https://flag.example.test/\n",
    );
    const withEnv = await device({ SUPERBOT_SERVER: "https://env.example.test" });
    await withEnv(["server", "https://saved.example.test"]);
    expect((await withEnv(["server"])).stdout).toBe("https://env.example.test/\n");
    expect((await withEnv(["server", "--server", "https://flag.example.test"])).stdout).toBe(
      "https://flag.example.test/\n",
    );
  });

  it("accepts HTTPS or loopback HTTP only", async () => {
    const plain = await cli(["server", "http://example.test"]);
    expect(plain).toMatchObject({
      code: 1,
      stderr:
        "superbot: Use an HTTPS Superbot origin or a local HTTP origin such as http://127.0.0.1:3000\n",
    });
    expect((await cli(["--server", "http://localhost:3000", "server"])).stdout).toBe(
      "http://localhost:3000/\n",
    );
  });
});

describe("sessions", () => {
  it("signs in from a script, shows the account and signs out", async () => {
    const server = await loopback([signIn(), me(), authOk("/api/auth/sign-out")]);
    const run = await device();
    const login = await run(
      ["--server", server.origin, "login", "--email", " fixture@example.test ", "--password-stdin"],
      { piped: "correct horse\r\n" },
    );
    expect(login).toEqual({ code: 0, stdout: `Signed in to ${server.origin}/\n`, stderr: "" });
    expect(server.requests[0]?.body).toEqual({
      email: "fixture@example.test",
      password: "correct horse",
    });
    const whoami = await run(["--server", server.origin, "whoami", "--json"]);
    expect(JSON.parse(whoami.stdout)).toEqual({
      server: `${server.origin}/`,
      userId: "user-1",
      email: "fixture@example.test",
      name: "Fixture",
    });
    expect(await run(["--server", server.origin, "logout"])).toEqual({
      code: 0,
      stdout: "Signed out.\n",
      stderr: "",
    });
    expect((await run(["--server", server.origin, "logout"])).stdout).toBe("Already signed out.\n");
    server.assertDone();
  });

  it("saves the session in a private file when there is no system credential store", async () => {
    const server = await loopback([signIn()]);
    const result = await cli(
      ["--server", server.origin, "login", "--email", "fixture@example.test", "--password-stdin"],
      { terminal: { piped: "secret" }, store: memoryStore(false) },
    );
    const file = path.join(result.context.directory, "sessions.json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      `No system credential store is available, so the session is saved in ${file}, readable only by you.\n`,
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      [`${server.origin}/`]: "fixture.signed",
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("signs in at a terminal with a password or an emailed code", async () => {
    const server = await loopback([
      signIn(),
      authOk("/api/auth/email-otp/send-verification-otp"),
      signIn("/api/auth/sign-in/email-otp"),
    ]);
    const password = await cli(["--server", server.origin, "login"], {
      terminal: { stdinIsTerminal: true, lines: ["fixture@example.test", "pw"] },
    });
    expect(password.stdout).toBe(`Email: Signed in to ${server.origin}/\n`);
    expect(password.stderr).toBe("Password: ");
    const code = await cli(
      ["--server", server.origin, "login", "--code", "--email", "a@example.test"],
      {
        terminal: { stdinIsTerminal: true, lines: [" 123456 "] },
      },
    );
    expect(code.stderr).toBe("Email code: ");
    expect(server.requests.map((request) => request.body)).toEqual([
      { email: "fixture@example.test", password: "pw" },
      { email: "a@example.test", type: "sign-in" },
      { email: "a@example.test", otp: "123456" },
    ]);
    server.assertDone();
  });

  it("explains what a script without a session or terminal must do", async () => {
    expect(await cli(["whoami"])).toMatchObject({
      code: 1,
      stderr: "superbot: No saved session for this server. Run superbot login first.\n",
    });
    expect((await cli(["login"])).stderr).toBe(
      "superbot: Sign-in requires an interactive terminal.\n",
    );
    expect((await cli(["signup"])).stderr).toBe(
      "superbot: Account creation requires an interactive terminal.\n",
    );
    expect(
      (
        await cli(["login", "--email", "a@example.test", "--password-stdin"], {
          terminal: { piped: "\n" },
        })
      ).stderr,
    ).toBe("superbot: Pipe the password to standard input.\n");
    expect(
      (await cli(["login"], { terminal: { stdinIsTerminal: true, lines: [" "] } })).stderr,
    ).toBe("superbot: Enter your email address.\n");
  });

  it("points a rejected session at superbot login", async () => {
    const server = await loopback(
      [refused("me", {}, 401, "UNAUTHORIZED", "Session expired")].map((exchange) => ({
        ...exchange,
        space: null,
      })),
    );
    const result = await cli(["--server", server.origin, "whoami"], {
      token: { origin: server.origin },
    });
    expect(result).toMatchObject({
      code: 1,
      stderr:
        "superbot: Session expired or rejected. Run superbot login for this server: Superbot returned HTTP 401: Session expired\n",
    });
  });

  it("creates an account and saves its session, or asks for the verification email", async () => {
    const server = await loopback([
      signIn("/api/auth/sign-up/email"),
      {
        path: "/api/auth/sign-up/email",
        space: null,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: null }),
      },
    ]);
    const lines = ["Ada", "ada@example.test", "pw", "pw"];
    const signedIn = await cli(["--server", server.origin, "signup"], {
      terminal: { stdinIsTerminal: true, lines },
    });
    expect(signedIn.stdout).toBe(
      `Create an account at ${server.origin}/\nDisplay name: Email: Signed in to ${server.origin}/\n`,
    );
    const verify = await cli(["--server", server.origin, "signup"], {
      terminal: { stdinIsTerminal: true, lines },
    });
    expect(verify.stdout).toContain(
      "Check your email for the verification link, then run superbot login.\n",
    );
    const differ = await cli(["--server", server.origin, "signup"], {
      terminal: { stdinIsTerminal: true, lines: ["Ada", "ada@example.test", "pw", "other"] },
    });
    expect(differ.stderr).toContain("superbot: Passwords differ.\n");
    server.assertDone();
  });
});

describe("commands with a session", () => {
  async function signedIn(exchanges: Exchange[], argv: string[], terminal: Terminal = {}) {
    const server = await loopback(exchanges);
    const result = await cli(["--server", server.origin, ...argv], {
      terminal,
      token: { origin: server.origin },
    });
    server.assertDone();
    return result;
  }

  it("lists Spaces and agents", async () => {
    const result = await signedIn(discovery(), ["list", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "space-1", name: "Personal", agents: [{ id: "bot-1", name: "Tools" }] },
    ]);
  });

  it("chats with an agent by name and prints the reply as it streams", async () => {
    const empty = snapshot(card());
    empty.messages = [];
    empty.activeRuns = [];
    const result = await signedIn(
      [
        ...discovery(),
        me(),
        rpc("threads/get", { botId: "bot-1" }, empty),
        rpc(
          "threads/send",
          { botId: "bot-1", text: "What colour?" },
          { taskId: "task-1", runId: "run-1", seq: 6 },
          { fresh: ["clientNonce"] },
        ),
        events(5, [
          event(6, "thread.progress", { streaming: true, delta: "The fixture " }),
          event(7, "thread.message.created", {
            messageId: "reply-1",
            seq: 7,
            role: "bot",
            blocks: [{ kind: "text", text: "The fixture response is blue." }],
          }),
          event(8, "run.completed", {}),
        ]),
      ],
      ["tools"],
      { lines: ["What colour?", "/quit"] },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      "Personal / Tools\nType a message and press Enter. /back returns to the picker. /quit exits.\nYou > Waiting for Tools…\nTools > The fixture response is blue.\nYou > ",
    );
  });

  it("offers the picker and goes back to it", async () => {
    const empty = snapshot(card());
    empty.messages = [];
    empty.activeRuns = [];
    const result = await signedIn(
      [...discovery(), me(), rpc("threads/get", { botId: "bot-1" }, empty)],
      [],
      { lines: ["9", "1", "/back", ""] },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("Choose a number from 1 to 1.\n");
    expect(result.stdout.split("Choose an agent\n  1. Personal / Tools\n")).toHaveLength(4);
  });

  it("manages workspaces", async () => {
    const spaces = rpc(
      "spaces/list",
      {},
      {
        current: { id: "space-1" },
        spaces: [
          { id: "space-1", name: "Personal" },
          { id: "space-2", name: "Weekend plans" },
        ],
      },
      { space: null },
    );
    const organizations = {
      ...refused("organizations/list", {}, 404, "NOT_FOUND", "Not found"),
      space: null,
    };
    expect((await signedIn([spaces, organizations], ["workspaces", "list"])).stdout).toBe(
      "space-1\tPersonal\nspace-2\tWeekend plans\n",
    );
    expect(
      (
        await signedIn(
          [
            rpc(
              "spaces/create",
              { name: "Trip" },
              { id: "space-3", name: "Trip" },
              { space: null },
            ),
          ],
          ["workspaces", "create", " Trip "],
        )
      ).stdout,
    ).toBe("space-3\tTrip\n");
    expect(
      (
        await signedIn(
          [
            spaces,
            organizations,
            rpc(
              "spaces/invites/create",
              { spaceId: "space-2" },
              { url: "https://example.test/invite/abc", expiresAt: "2026-12-01T00:00:00Z" },
              { space: "space-2" },
            ),
          ],
          ["--space", "weekend plans", "workspaces", "invite"],
        )
      ).stdout,
    ).toBe("https://example.test/invite/abc\n");
    expect(
      (
        await signedIn(
          [
            spaces,
            organizations,
            rpc(
              "spaces/members/list",
              { spaceId: "space-2" },
              {
                spaceName: "Weekend plans",
                canManage: true,
                members: [
                  {
                    userId: "u1",
                    name: "Ada",
                    email: "ada@example.test",
                    image: null,
                    role: "owner",
                  },
                  {
                    userId: "u2",
                    name: "Grace",
                    email: "grace@example.test",
                    image: null,
                    role: "member",
                  },
                ],
              },
              { space: "space-2" },
            ),
          ],
          ["workspaces", "members", "--space", "space-2"],
        )
      ).stdout,
    ).toBe("owner\tAda\nmember\tGrace\n");
    expect(
      (
        await signedIn(
          [
            spaces,
            organizations,
            rpc(
              "spaces/members/leave",
              { spaceId: "space-2" },
              { ok: true, activeSpaceId: "space-1" },
              { space: "space-2" },
            ),
          ],
          ["workspaces", "leave", "--space", "Weekend plans"],
        )
      ).stdout,
    ).toBe("Left Weekend plans\n");
    expect(
      (await cli(["workspaces", "leave"], { token: { origin: "http://127.0.0.1:5173" } })).stderr,
    ).toBe("superbot: Choose the workspace with --space NAME or --space ID\n");
  });

  it("joins a workspace with the invite's server and its saved session", async () => {
    const server = await loopback([
      rpc(
        "spaces/invites/preview",
        { token: "abc_1" },
        {
          spaceId: "space-2",
          spaceName: "Weekend plans",
          inviterName: "Ada",
          alreadyMember: false,
        },
        { space: null },
      ),
      rpc("spaces/invites/accept", { token: "abc_1" }, { spaceId: "space-2" }, { space: null }),
    ]);
    const link = `${server.origin}/invite/abc_1`;
    const joined = await cli(["workspaces", "join", link], { token: { origin: server.origin } });
    expect(joined).toMatchObject({ code: 0, stdout: "space-2\tWeekend plans\n" });
    server.assertDone();
    expect((await cli(["workspaces", "join", link])).stderr).toBe(
      `superbot: Sign in first with superbot --server ${server.origin}/ login\n`,
    );
    expect(
      (await cli(["--server", "https://other.example.test", "workspaces", "join", link])).stderr,
    ).toBe("superbot: The invite is for a different Superbot server\n");
    expect((await cli(["workspaces", "join", "https://example.test/nope"])).stderr).toBe(
      "superbot: Use the full Superbot workspace invite link\n",
    );
    expect((await cli(["workspaces", "join", "https://example.test/invite/a b"])).stderr).toBe(
      "superbot: The workspace invite link is invalid\n",
    );
  });

  it("imports roster names, previewing first", async () => {
    const spaces = rpc(
      "spaces/list",
      {},
      { current: { id: "space-1" }, spaces: [{ id: "space-1", name: "Personal" }] },
      { space: null },
    );
    const organizations = {
      ...refused("organizations/list", {}, 404, "NOT_FOUND", "Not found"),
      space: null,
    };
    const existing = [
      rpc("bots/list", {}, [{ id: "bot-1", name: " ada " }]),
      rpc("bots/listArchived", {}, [{ id: "bot-2", name: "Milo" }]),
    ];
    const server = await loopback([
      spaces,
      organizations,
      ...existing,
      spaces,
      organizations,
      ...existing,
      rpc(
        "bots/create",
        { name: "Scout", spawnKey: rosterKey("Scout") },
        { id: "bot-3", name: "Scout" },
      ),
    ]);
    const first = scriptedIo();
    const context = await testContext(first.io);
    const roster = path.join(context.directory, "..", "roster.json");
    await writeFile(roster, JSON.stringify({ names: ["Ada", "Milo", "Scout"] }));
    await context.credentials.save(new Client(server.origin).withToken("fixture.signed"));
    const dryRun = await runCli(
      ["--server", server.origin, "--space", "Personal", "import-bots", roster, "--dry-run"],
      context,
    );
    expect(dryRun).toBe(0);
    expect(first.stdout()).toBe("Space Personal (space-1): 2 existing, 1 to import.\n  Scout\n");
    const second = scriptedIo();
    await runCli(["--server", server.origin, "--space", "space-1", "import-bots", roster], {
      ...context,
      io: second.io,
    });
    expect(second.stdout()).toBe(
      "Space Personal (space-1): 2 existing, 1 to import.\nRoster import complete.\n",
    );
    server.assertDone();
    expect((await cli(["import-bots", roster])).stderr).toBe(
      "superbot: Choose the destination with --space NAME or --space ID\n",
    );
  });

  it("prints usage errors with status 2 and help with status 0", async () => {
    const usage = await cli(["send"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain(
      "error: the following required arguments were not provided:\n  <AGENT>",
    );
    const help = await cli(["approvals", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: superbot approvals [OPTIONS] [COMMAND]");
  });
});
