/**
 * The `superbot` command against a real local server: the API runs in this process on a loopback
 * port with a throwaway database, the fake sandbox and the scripted agent runtime, and the built
 * command runs as a child process with a temporary settings directory. No hosted model or cloud
 * credential is used, and the session is kept in the private sessions file because the child has
 * no system credential store to reach.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeCli = hasDb ? describe : describe.skip;

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cliPackage = path.join(root, "apps/cli");

type Result = { code: number | null; stdout: string; stderr: string };

describeCli("superbot command against a local server", () => {
  let server: Server;
  let stop: () => Promise<void>;
  let origin: string;
  let home: string;
  let bin: string;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-superbot-cli-"));
  const email = `cli-${Date.now()}@rakazo.test`;
  const password = "fixture password 12";

  /** Runs the built command as a person or script on a computer without a credential store would. */
  function superbot(args: string[], input = ""): Promise<Result> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, "--server", origin, ...args], {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          SUPERBOT_CONFIG_DIR: path.join(home, "settings"),
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 90_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  async function post(route: string, body: unknown, token?: string, space?: string) {
    const response = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(space ? { "x-rakazo-space-id": space } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return response;
  }

  async function rpc<T>(route: string, input: unknown, token: string, space?: string): Promise<T> {
    const response = await post(`/rpc/${route}`, { json: input }, token, space);
    return ((await response.json()) as { json: T }).json;
  }

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "superbot-cli-home-"));
    bin = path.join(cliPackage, "dist", `e2e-${process.pid}`, "superbot.js");
    await promisify(execFile)(process.execPath, [path.join(cliPackage, "build.mjs"), bin], {
      cwd: cliPackage,
    });
    const [{ createApp }, { serve }] = await Promise.all([
      import("@rakazo/api/app"),
      import("@hono/node-server"),
    ]);
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    stop = handles.stop;
    server = await new Promise<Server>((resolve) => {
      const listening = serve({ fetch: handles.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(listening as Server),
      );
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await post("/api/auth/sign-up/email", { name: "Fixture", email, password });
  }, 180_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await stop?.();
    await rm(home, { recursive: true, force: true });
    await rm(path.dirname(bin), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("signs in from a script, chats, follows approvals and manages workspaces", async () => {
    expect((await superbot(["whoami"])).stderr).toBe(
      "superbot: No saved session for this server. Run superbot login first.\n",
    );

    const login = await superbot(["login", "--email", email, "--password-stdin"], `${password}\n`);
    const sessions = path.join(home, "settings", "sessions.json");
    expect(login).toEqual({
      code: 0,
      stdout: `Signed in to ${origin}/\n`,
      stderr: `No system credential store is available, so the session is saved in ${sessions}, readable only by you.\n`,
    });
    const token = (JSON.parse(await readFile(sessions, "utf8")) as Record<string, string>)[
      `${origin}/`
    ];
    if (!token) throw new Error("The session file holds no session for the server");
    if (process.platform !== "win32") expect((await stat(sessions)).mode & 0o777).toBe(0o600);

    const whoami = await superbot(["whoami", "--json"]);
    expect(JSON.parse(whoami.stdout)).toMatchObject({
      server: `${origin}/`,
      email,
      name: "Fixture",
    });

    const { spaces } = await rpc<{ spaces: Array<{ id: string; name: string }> }>(
      "spaces/list",
      {},
      token,
    );
    const space = spaces[0];
    if (!space) throw new Error("The new account has no Space");
    await rpc(
      "bots/create",
      {
        name: "Fixture agent",
        title: "Fixture agent",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      },
      token,
      space.id,
    );
    const list = await superbot(["--space", space.name, "list", "--json"]);
    expect(JSON.parse(list.stdout)).toEqual([
      {
        id: space.id,
        name: space.name,
        agents: [expect.objectContaining({ name: "Fixture agent" })],
      },
    ]);

    const sent = await superbot(["send", "fixture agent", "Summarize the CLI fixture"]);
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stderr).toBe("");
    expect(sent.stdout).toContain("on it. i will work this in the background");
    const json = await superbot(["--json", "send", "Fixture agent"], "Summarize it again\n");
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "completed" });
    expect(JSON.parse(json.stdout).reply).toContain("on it.");

    const threads = await superbot(["threads", "list", "Fixture agent", "--json"]);
    const [first] = JSON.parse(threads.stdout) as Array<{ threadId: string; first: boolean }>;
    expect(first).toMatchObject({ first: true });
    const shown = await superbot(["threads", "show", "Fixture agent"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("Fixture > Summarize the CLI fixture\n");
    expect(shown.stdout).toContain("Fixture agent > on it.");
    const added = await superbot([
      "send",
      "Fixture agent",
      "--new-conversation",
      "A separate topic",
    ]);
    expect(added.code, added.stderr).toBe(0);
    const conversation = /^Conversation (\S+)\n/.exec(added.stderr)?.[1] ?? "";
    const rows = JSON.parse(
      (await superbot(["threads", "list", "Fixture agent", "--json"])).stdout,
    );
    expect(rows.map((row: { threadId: string }) => row.threadId)).toContain(conversation);
    const separate = await superbot(["threads", "show", "Fixture agent", conversation]);
    expect(separate.stdout, separate.stderr).toContain("Fixture > A separate topic\n");
    expect(separate.stdout).not.toContain("Summarize the CLI fixture");

    const waiting = await superbot(["send", "Fixture agent", "show a fetch approval card"]);
    expect(waiting.code, waiting.stderr).toBe(3);
    expect(waiting.stderr).toContain("Approval required\n");
    const approvals = await superbot(["approvals", "--json"]);
    const [approval] = JSON.parse(approvals.stdout) as Array<{ id: string; agentName: string }>;
    expect(approval).toMatchObject({ agentName: "Fixture agent" });
    expect(waiting.stderr).toContain(`superbot approvals allow ${approval?.id}`);
    expect(await superbot(["approvals", "deny", approval?.id ?? ""])).toEqual({
      code: 0,
      stdout: "Denied.\n",
      stderr: "",
    });
    await vi.waitFor(
      async () =>
        expect((await superbot(["approvals"])).stdout).toBe("No approvals are waiting.\n"),
      { timeout: 30_000, interval: 500 },
    );

    const created = await superbot(["workspaces", "create", "Weekend plans"]);
    expect(created.stdout).toMatch(/^\S+\tWeekend plans\n$/);
    expect((await superbot(["workspaces", "list"])).stdout).toContain("\tWeekend plans\n");
    const invite = await superbot(["--space", "Weekend plans", "workspaces", "invite"]);
    expect(invite.stdout).toContain("/invite/");
    expect((await superbot(["--space", "Weekend plans", "workspaces", "members"])).stdout).toBe(
      "owner\tFixture\n",
    );

    expect(await superbot(["logout"])).toEqual({ code: 0, stdout: "Signed out.\n", stderr: "" });
    expect((await superbot(["whoami"])).code).toBe(1);
  }, 300_000);
});
