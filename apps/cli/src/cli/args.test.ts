import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { parseArgs } from "./args.js";

const run = (argv: string[], env: Record<string, string> = {}) => {
  const parsed = parseArgs(argv, env);
  if (parsed.kind !== "run")
    throw new Error(
      `Expected a command, got ${parsed.kind}: ${"text" in parsed ? parsed.text : ""}`,
    );
  return parsed;
};

describe("parseArgs", () => {
  it("opens a chat by name and reaches agents named like commands with chat", () => {
    expect(run(["Research agent"]).command).toEqual({
      kind: "chat",
      agent: "Research agent",
      newConversation: false,
      conversation: undefined,
    });
    expect(run(["chat", "login"]).command).toEqual({
      kind: "chat",
      agent: "login",
      newConversation: false,
      conversation: undefined,
    });
    expect(run([]).command).toMatchObject({ kind: "chat", agent: undefined });
    expect(run(["login"]).command).toEqual({
      kind: "login",
      email: undefined,
      code: false,
      passwordStdin: false,
    });
  });

  it("reads global options before or after the command, and from the environment", () => {
    const parsed = run(["--json", "--space", "Team", "send", "Tools", "What", "colour?"]);
    expect(parsed.global).toEqual({
      server: undefined,
      serverOverridden: false,
      space: "Team",
      json: true,
    });
    expect(parsed.command).toEqual({
      kind: "send",
      agent: "Tools",
      message: ["What", "colour?"],
      newConversation: false,
      conversation: undefined,
    });
    expect(run(["list", "--json", "--server=https://example.test"]).global).toMatchObject({
      json: true,
      server: "https://example.test",
      serverOverridden: true,
    });
    const fromEnv = run(["list"], { SUPERBOT_SPACE: "Home", SUPERBOT_SERVER: "https://env.test" });
    expect(fromEnv.global).toEqual({
      server: undefined,
      serverOverridden: true,
      space: "Home",
      json: false,
    });
    expect(run(["--space", "Flag", "list"], { SUPERBOT_SPACE: "Home" }).global.space).toBe("Flag");
  });

  it("parses every command", () => {
    expect(run(["approvals"]).command).toEqual({ kind: "approvals", answer: undefined });
    expect(run(["approvals", "deny", "message-1"]).command).toEqual({
      kind: "approvals",
      answer: { id: "message-1", answer: "deny" },
    });
    expect(run(["threads", "show", "Tools", "thread-2"]).command).toEqual({
      kind: "threadsShow",
      agent: "Tools",
      threadId: "thread-2",
    });
    expect(run(["threads", "list", "Tools"]).command).toEqual({
      kind: "threadsList",
      agent: "Tools",
    });
    expect(run(["workspaces", "join", "https://example.test/invite/abc"]).command).toEqual({
      kind: "workspaces",
      command: { kind: "join", link: "https://example.test/invite/abc" },
    });
    expect(run(["workspaces", "members"]).command).toEqual({
      kind: "workspaces",
      command: { kind: "members" },
    });
    expect(run(["import-bots", "roster.json", "--dry-run"]).command).toEqual({
      kind: "importBots",
      file: "roster.json",
      dryRun: true,
    });
    expect(run(["chat", "Tools", "--conversation", "thread-9"]).command).toEqual({
      kind: "chat",
      agent: "Tools",
      newConversation: false,
      conversation: "thread-9",
    });
    expect(run(["server", "https://example.test"]).command).toEqual({
      kind: "server",
      url: "https://example.test",
    });
    expect(run(["login", "--email", "a@example.test", "--password-stdin"]).command).toEqual({
      kind: "login",
      email: "a@example.test",
      code: false,
      passwordStdin: true,
    });
    expect(run(["send", "Tools", "--", "-1", "degrees"]).command).toMatchObject({
      message: ["-1", "degrees"],
    });
  });

  it("refuses what clap refused, with exit status 2", () => {
    for (const argv of [
      ["login", "--password-stdin"],
      ["login", "--email", "a@example.test", "--code", "--password-stdin"],
      ["send", "Tools", "Hi", "--new-conversation", "--conversation", "thread-1"],
      ["send"],
      ["threads"],
      ["workspaces"],
      ["approvals", "maybe", "x"],
      ["list", "extra"],
      ["--email", "a@example.test", "login"],
      ["Tools", "extra"],
      ["--json", "--json", "list"],
      ["--server"],
    ]) {
      expect(parseArgs(argv, {}).kind, argv.join(" ")).toBe("usage");
    }
    const missing = parseArgs(["login", "--password-stdin"], {});
    expect(missing).toEqual({
      kind: "usage",
      text: "error: the following required arguments were not provided:\n  --email <EMAIL>\n\nUsage: superbot login [OPTIONS]\n\nFor more information, try '--help'.\n",
    });
  });

  it("prints help and the version", () => {
    const help = parseArgs(["--help"], {});
    expect(help.kind).toBe("print");
    expect(help.kind === "print" && help.text).toContain(
      "Usage: superbot [OPTIONS] [AGENT] [COMMAND]",
    );
    expect(parseArgs(["-V"], {})).toEqual({
      kind: "version",
      text: `superbot-cli ${packageJson.version}\n`,
    });
    const sendHelp = parseArgs(["help", "send"], {});
    expect(sendHelp.kind === "print" && sendHelp.text).toContain(
      "Usage: superbot send [OPTIONS] <AGENT> [MESSAGE]...",
    );
    const subHelp = parseArgs(["workspaces", "create", "-h"], {});
    expect(subHelp.kind === "print" && subHelp.text).toContain(
      "Create a workspace with you as its only member",
    );
  });
});
