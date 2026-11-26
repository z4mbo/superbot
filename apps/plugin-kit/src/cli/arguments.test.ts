import { describe, expect, it } from "vitest";
import { parseCommandLine } from "./arguments.js";

const parse = (...argv: string[]) => parseCommandLine(argv, {});
const command = (...argv: string[]) => {
  const parsed = parse(...argv);
  if ("code" in parsed) throw new Error(parsed.stderr ?? parsed.stdout);
  return parsed;
};
const MORE = "For more information, try '--help'.\n";
const usageError = (message: string, usage?: string) => ({
  code: 2,
  stderr: `error: ${message}\n\n${usage ? `Usage: superbot-plugin ${usage}\n\n` : ""}${MORE}`,
});

const ROOT_HELP = `Develop plugins for the Superbot registry

Usage: superbot-plugin [OPTIONS] <COMMAND>

Commands:
  init            Create a starter skill, TypeScript MCP app or record app [alias: scaffold]
  validate        Validate a manifest locally
  publish         Submit a new version for review [alias: submit]
  app-init        Create an app folder with hosted records, server functions and a card
  app-check       Check an app folder as the server will
  app-publish     Submit an app folder's version for review
  list            List approved versions, your submissions, installations, or the reviewer queue
  status          Look up one of your submitted versions by ID
  agents          List Space agents and their IDs for grants
  install         Install an approved version in the Space
  switch-version  Switch an installation to an approved version and clear all of its grants
  set-grants      Replace one agent's grants. Omit part IDs to revoke all grants for that agent [alias: grant]
  uninstall       Remove an installation and its grants
  review          Approve or reject a pending submission as a deployment admin
  help            Print this message or the help of the given subcommand(s)

Options:
      --server <SERVER>  [env: SUPERBOT_SERVER=]
      --space <SPACE>    Select a Space by exact name or ID
  -h, --help             Print help
  -V, --version          Print version
`;

describe("commands", () => {
  it("reads every command with its defaults", () => {
    expect(command("init", "release-notes")).toEqual({
      command: {
        kind: "init",
        slug: "release-notes",
        manifest: "plugin.json",
        template: "skill",
        name: undefined,
      },
      server: undefined,
      space: undefined,
    });
    expect(command("validate").command).toEqual({ kind: "validate", manifest: "plugin.json" });
    expect(command("validate", "custom.json").command).toEqual({
      kind: "validate",
      manifest: "custom.json",
    });
    expect(command("publish", "x", "+7").command).toEqual({
      kind: "publish",
      slug: "x",
      version: 7,
      manifest: "plugin.json",
    });
    expect(command("list").command).toMatchObject({ kind: "list", scope: "discover", limit: 20 });
    expect(command("status", "v").command).toEqual({ kind: "status", versionId: "v" });
    expect(command("agents").command).toEqual({ kind: "agents" });
    expect(command("install", "v").command).toEqual({ kind: "install", versionId: "v" });
    expect(command("switch-version", "i", "old", "new").command).toEqual({
      kind: "switch-version",
      installationId: "i",
      expectedVersionId: "old",
      versionId: "new",
    });
    expect(command("set-grants", "i", "b", "one", "two").command).toEqual({
      kind: "set-grants",
      installationId: "i",
      botId: "b",
      partIds: ["one", "two"],
    });
    expect(command("uninstall", "i").command).toEqual({ kind: "uninstall", installationId: "i" });
    expect(command("review", "v", "rejected", "--reason", "No").command).toEqual({
      kind: "review",
      versionId: "v",
      decision: "rejected",
      reason: "No",
    });
  });

  it("accepts the aliases", () => {
    expect(command("scaffold", "x", "--template", "mcp-app").command).toMatchObject({
      kind: "init",
      template: "mcp-app",
    });
    expect(command("submit", "x", "1").command.kind).toBe("publish");
    expect(command("grant", "i", "b").command).toMatchObject({ kind: "set-grants", partIds: [] });
  });

  it("takes global options before or after the command, the later one winning", () => {
    expect(command("--server", "https://a.example", "agents", "--space", "Team")).toMatchObject({
      server: "https://a.example",
      space: "Team",
    });
    expect(
      command("--server", "https://a.example", "agents", "--server", "https://b.example"),
    ).toMatchObject({ server: "https://b.example" });
    expect(command("--space=Team", "agents").space).toBe("Team");
  });

  it("takes option values inline, and positionals after --", () => {
    expect(command("init", "x", "--name=-q").command).toMatchObject({ name: "-q" });
    expect(command("grant", "i", "b", "--", "--part").command).toMatchObject({
      partIds: ["--part"],
    });
  });

  it("holds versions and page sizes to their ranges", () => {
    expect(command("publish", "x", "2147483647").command).toMatchObject({ version: 2147483647 });
    expect(command("list", "--limit", "1").command).toMatchObject({ limit: 1 });
    expect(command("list", "--limit", "50").command).toMatchObject({ limit: 50 });
    expect(parse("publish", "x", "0")).toEqual({
      code: 2,
      stderr: `error: invalid value '0' for '<VERSION>': 0 is not in 1..=2147483647\n\n${MORE}`,
    });
    expect(parse("publish", "x", "2147483648")).toEqual({
      code: 2,
      stderr: `error: invalid value '2147483648' for '<VERSION>': 2147483648 is not in 1..=2147483647\n\n${MORE}`,
    });
    expect(parse("publish", "x", "abc")).toEqual(
      usageError("invalid value 'abc' for '<VERSION>': invalid digit found in string"),
    );
    expect(parse("publish", "x", "")).toEqual(
      usageError("invalid value '' for '<VERSION>': cannot parse integer from empty string"),
    );
    expect(parse("list", "--limit", "51")).toEqual(
      usageError("invalid value '51' for '--limit <LIMIT>': 51 is not in 1..=50"),
    );
    expect(parse("list", "--limit", "0")).toEqual(
      usageError("invalid value '0' for '--limit <LIMIT>': 0 is not in 1..=50"),
    );
    expect(parse("list", "--limit", "99999999999999999999")).toEqual(
      usageError(
        "invalid value '99999999999999999999' for '--limit <LIMIT>': number too large to fit in target type",
      ),
    );
    expect(parse("publish", "x", "-1")).toEqual(
      usageError(
        "unexpected argument '-1' found\n\n  tip: to pass '-1' as a value, use '-- -1'",
        "publish [OPTIONS] <SLUG> <VERSION>",
      ),
    );
    expect(parse("list", "--limit", "-1")).toEqual(
      usageError(
        "unexpected argument '-1' found\n\n  tip: to pass '-1' as a value, use '-- -1'",
        "list [OPTIONS] [SCOPE]",
      ),
    );
  });

  it("requires a reason only for a rejection", () => {
    expect(command("review", "v", "approved").command).toEqual({
      kind: "review",
      versionId: "v",
      decision: "approved",
      reason: undefined,
    });
    expect(parse("review", "v", "rejected")).toEqual(
      usageError(
        "the following required arguments were not provided:\n  --reason <REASON>",
        "review --reason <REASON> <VERSION_ID> <DECISION>",
      ),
    );
    expect(parse("review", "v")).toEqual(
      usageError(
        "the following required arguments were not provided:\n  <DECISION>",
        "review <VERSION_ID> <DECISION>",
      ),
    );
    expect(parse("review", "v", "maybe")).toEqual(
      usageError("invalid value 'maybe' for '<DECISION>'\n  [possible values: approved, rejected]"),
    );
  });

  it("refuses unknown choices with the possible values", () => {
    expect(parse("list", "nope")).toEqual(
      usageError(
        "invalid value 'nope' for '[SCOPE]'\n  [possible values: discover, mine, installations, submissions]",
      ),
    );
    expect(parse("list", "--status", "nope")).toEqual(
      usageError(
        "invalid value 'nope' for '--status <STATUS>'\n  [possible values: pending, approved, rejected]",
      ),
    );
    expect(parse("init", "x", "--template", "nope")).toEqual(
      usageError(
        "invalid value 'nope' for '--template <TEMPLATE>'\n  [possible values: skill, mcp-app, kcal-diary]",
      ),
    );
    expect(parse("init", "x", "--template")).toEqual(
      usageError(
        "a value is required for '--template <TEMPLATE>' but none was supplied\n  [possible values: skill, mcp-app, kcal-diary]",
      ),
    );
  });

  it("reports the command line's mistakes as the tool always has", () => {
    const tip = (raw: string) => `\n\n  tip: to pass '${raw}' as a value, use '-- ${raw}'`;
    for (const [argv, expected] of [
      [["bogus"], usageError("unrecognized subcommand 'bogus'", "[OPTIONS] <COMMAND>")],
      [
        ["-", "bogus"],
        usageError(
          "unrecognized subcommand '-'\n\n  tip: some similar subcommands exist: 'set-grants', 'app-check', 'app-init'",
          "[OPTIONS] <COMMAND>",
        ),
      ],
      [["--", "bogus"], usageError("unrecognized subcommand 'bogus'", "[OPTIONS] <COMMAND>")],
      [
        ["--", "init"],
        usageError(
          "unexpected argument 'init' found\n\n  tip: subcommand 'init' exists; to use it, remove the '--' before it",
          "[OPTIONS] <COMMAND>",
        ),
      ],
      [
        ["--bogus", "init"],
        usageError("unexpected argument '--bogus' found", "[OPTIONS] <COMMAND>"),
      ],
      [
        ["init"],
        usageError("the following required arguments were not provided:\n  <SLUG>", "init <SLUG>"),
      ],
      [
        ["init", "x", "--name"],
        usageError("a value is required for '--name <NAME>' but none was supplied"),
      ],
      [
        ["init", "x", "--name", "--manifest", "y"],
        usageError("a value is required for '--name <NAME>' but none was supplied"),
      ],
      [
        ["init", "x", "--name", "-q"],
        usageError(`unexpected argument '-q' found${tip("-q")}`, "init [OPTIONS] <SLUG>"),
      ],
      [
        ["init", "x", "--name", "a", "--name", "b"],
        usageError(
          "the argument '--name <NAME>' cannot be used multiple times",
          "init [OPTIONS] <SLUG>",
        ),
      ],
      [
        ["init", "x", "--bogus"],
        usageError(`unexpected argument '--bogus' found${tip("--bogus")}`, "init <SLUG>"),
      ],
      [
        ["init", "x", "--name", "a", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "init --name <NAME> <SLUG>",
        ),
      ],
      [["init", "x", "y"], usageError("unexpected argument 'y' found", "init [OPTIONS] <SLUG>")],
      [
        ["init", "x", "-V"],
        usageError(`unexpected argument '-V' found${tip("-V")}`, "init [OPTIONS] <SLUG>"),
      ],
      [
        ["list", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "list [OPTIONS] [SCOPE]",
        ),
      ],
      [
        ["list", "mine", "--bogus"],
        usageError(`unexpected argument '--bogus' found${tip("--bogus")}`, "list <SCOPE>"),
      ],
      [
        ["list", "--limit", "5", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "list --limit <LIMIT> [SCOPE]",
        ),
      ],
      [
        ["set-grants", "a", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "set-grants <INSTALLATION_ID> <BOT_ID> [PART_IDS]...",
        ),
      ],
      [
        ["agents", "--bogus"],
        usageError("unexpected argument '--bogus' found", "agents [OPTIONS]"),
      ],
      [
        ["review", "v", "rejected", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "review <VERSION_ID> <DECISION>",
        ),
      ],
      [
        ["review", "v", "rejected", "--reason", "r", "--bogus"],
        usageError(
          `unexpected argument '--bogus' found${tip("--bogus")}`,
          "review --reason <REASON> <VERSION_ID> <DECISION>",
        ),
      ],
      [
        ["publish", "x", "1", "2"],
        usageError("unexpected argument '2' found", "publish [OPTIONS] <SLUG> <VERSION>"),
      ],
      [
        ["--server"],
        usageError("a value is required for '--server <SERVER>' but none was supplied"),
      ],
      [
        ["--server", "a", "--server", "b", "agents"],
        usageError(
          "the argument '--server <SERVER>' cannot be used multiple times",
          "[OPTIONS] <COMMAND>",
        ),
      ],
      [
        ["agents", "--server", "a", "--server", "b"],
        usageError(
          "the argument '--server <SERVER>' cannot be used multiple times",
          "agents [OPTIONS]",
        ),
      ],
      [["help", "nope"], usageError("unrecognized subcommand 'nope'", "[OPTIONS] <COMMAND>")],
      [
        ["help", "init", "extra"],
        usageError("unrecognized subcommand 'extra'", "init [OPTIONS] <SLUG>"),
      ],
    ] as const) {
      expect(parse(...argv), argv.join(" ")).toEqual(expected);
    }
  });

  it("prints help and the version", () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["-h", "init"]]) {
      expect(parse(...argv)).toEqual({ code: 0, stdout: ROOT_HELP });
    }
    expect(parse()).toEqual({ code: 2, stderr: ROOT_HELP });
    for (const argv of [["--version"], ["-V"], ["--version", "extra"]]) {
      expect(parse(...argv)).toEqual({ code: 0, stdout: "superbot-plugin-kit 0.1.0\n" });
    }
    expect(parseCommandLine(["agents", "-h"], { SUPERBOT_SERVER: "https://x.example" })).toEqual({
      code: 0,
      stdout: `List Space agents and their IDs for grants

Usage: superbot-plugin agents [OPTIONS]

Options:
      --server <SERVER>  [env: SUPERBOT_SERVER=https://x.example]
      --space <SPACE>    Select a Space by exact name or ID
  -h, --help             Print help
`,
    });
  });

  it("prints each command's help, with the long form for init", () => {
    expect(parse("init", "-h")).toEqual({
      code: 0,
      stdout: `Create a starter skill, TypeScript MCP app or record app

Usage: superbot-plugin init [OPTIONS] <SLUG>

Arguments:
  <SLUG>\x20\x20

Options:
      --name <NAME>\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
      --server <SERVER>      [env: SUPERBOT_SERVER=]
      --manifest <MANIFEST>  [default: plugin.json]
      --space <SPACE>        Select a Space by exact name or ID
      --template <TEMPLATE>  [default: skill] [possible values: skill, mcp-app, kcal-diary]
  -h, --help                 Print help (see more with '--help')
`,
    });
    const long = `Create a starter skill, TypeScript MCP app or record app

Usage: superbot-plugin init [OPTIONS] <SLUG>

Arguments:
  <SLUG>
\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20

Options:
      --name <NAME>
\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20

      --server <SERVER>
          [env: SUPERBOT_SERVER=]

      --manifest <MANIFEST>
          [default: plugin.json]

      --space <SPACE>
          Select a Space by exact name or ID

      --template <TEMPLATE>
          Possible values:
          - skill
          - mcp-app
          - kcal-diary: A record app: a calorie diary whose meals the registry keeps per installation
\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
          [default: skill]

  -h, --help
          Print help (see a summary with '-h')
`;
    expect(parse("init", "--help")).toEqual({ code: 0, stdout: long });
    expect(parse("help", "scaffold")).toEqual({ code: 0, stdout: long });
    expect(parse("list", "-h")).toEqual({
      code: 0,
      stdout: `List approved versions, your submissions, installations, or the reviewer queue

Usage: superbot-plugin list [OPTIONS] [SCOPE]

Arguments:
  [SCOPE]  [default: discover] [possible values: discover, mine, installations, submissions]

Options:
      --after <AFTER>\x20\x20\x20\x20
      --server <SERVER>  [env: SUPERBOT_SERVER=]
      --limit <LIMIT>    [default: 20]
      --space <SPACE>    Select a Space by exact name or ID
      --slug <SLUG>      Filter approved versions by slug
      --query <QUERY>    Search approved versions by slug, name, or description
      --status <STATUS>  Filter the reviewer queue by status [possible values: pending, approved, rejected]
  -h, --help             Print help
`,
    });
    expect(parse("grant", "--help")).toEqual({
      code: 0,
      stdout: `Replace one agent's grants. Omit part IDs to revoke all grants for that agent

Usage: superbot-plugin set-grants [OPTIONS] <INSTALLATION_ID> <BOT_ID> [PART_IDS]...

Arguments:
  <INSTALLATION_ID>\x20\x20
  <BOT_ID>\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
  [PART_IDS]...\x20\x20\x20\x20\x20\x20

Options:
      --server <SERVER>  [env: SUPERBOT_SERVER=]
      --space <SPACE>    Select a Space by exact name or ID
  -h, --help             Print help
`,
    });
    expect(parse("init", "-h", "--bogus")).toMatchObject({ code: 0 });
    expect(parse("init", "--bogus", "-h")).toMatchObject({ code: 2 });
  });
});
