import packageJson from "../../package.json" with { type: "json" };
import type { ApprovalAnswer } from "../commands/approvals-command.js";
import type { WorkspaceCommand } from "../commands/workspaces.js";
import type { ArgSpec, CommandSpec, OptionSpec } from "./commands.js";
import { GLOBAL_OPTIONS, ROOT } from "./commands.js";

export type GlobalOptions = {
  /** `--server` as given; `SUPERBOT_SERVER` is read where the server is selected. */
  server: string | undefined;
  /** Whether `--server` or `SUPERBOT_SERVER` named a server for this invocation. */
  serverOverridden: boolean;
  /** `--space`, else `SUPERBOT_SPACE`. */
  space: string | undefined;
  json: boolean;
};

export type Command =
  | { kind: "server"; url: string | undefined }
  | { kind: "signup" }
  | { kind: "login"; email: string | undefined; code: boolean; passwordStdin: boolean }
  | { kind: "logout" }
  | { kind: "whoami" }
  | { kind: "list" }
  | {
      kind: "send";
      agent: string;
      message: string[];
      newConversation: boolean;
      conversation: string | undefined;
    }
  | { kind: "threadsList"; agent: string }
  | { kind: "threadsShow"; agent: string; threadId: string | undefined }
  | { kind: "approvals"; answer: ApprovalAnswer | undefined }
  | { kind: "tui" }
  | { kind: "workspaces"; command: WorkspaceCommand }
  | { kind: "importBots"; file: string; dryRun: boolean }
  /** A chat: `superbot`, `superbot AGENT` or `superbot chat AGENT`. */
  | {
      kind: "chat";
      agent: string | undefined;
      newConversation: boolean;
      conversation: string | undefined;
    };

export type Parsed =
  | { kind: "run"; global: GlobalOptions; command: Command }
  /** Help or the version, printed to standard output. */
  | { kind: "print"; text: string }
  /** A usage error, printed to standard error with exit status 2. */
  | { kind: "usage"; text: string };

const VERSION_NAME = "superbot-cli";

class UsageError extends Error {
  readonly path: CommandSpec[];

  constructor(message: string, path: CommandSpec[]) {
    super(message);
    this.path = path;
  }
}

const optionName = (option: OptionSpec) =>
  option.value ? `--${option.long} <${option.value}>` : `--${option.long}`;

const argName = (arg: ArgSpec) =>
  `${arg.required ? `<${arg.name}>` : `[${arg.name}]`}${arg.variadic ? "..." : ""}`;

function usageLine(path: CommandSpec[]): string {
  const command = path.at(-1) ?? ROOT;
  const names = path.map((spec) => spec.name).join(" ");
  const parts = [names, "[OPTIONS]", ...command.args.map(argName)];
  if (command.subcommands) parts.push(command.subcommandRequired ? "<COMMAND>" : "[COMMAND]");
  return `Usage: ${parts.join(" ")}`;
}

function table(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd()).join("\n");
}

/** The help for the command at the end of `path`, as `--help` prints it. */
export function helpText(path: CommandSpec[]): string {
  const command = path.at(-1) ?? ROOT;
  const sections = [command.about, usageLine(path)];
  if (command.subcommands) {
    sections.push(
      `Commands:\n${table([
        ...command.subcommands.map((sub): [string, string] => [sub.name, sub.about]),
        ["help", "Print this message or the help of the given subcommand(s)"],
      ])}`,
    );
  }
  if (command.args.length > 0) {
    sections.push(
      `Arguments:\n${table(command.args.map((arg): [string, string] => [argName(arg), arg.help ?? ""]))}`,
    );
  }
  const options: Array<[string, string]> = [...command.options, ...GLOBAL_OPTIONS].map((option) => [
    `    ${optionName(option)}`,
    [option.help, option.env && `[env: ${option.env}=]`].filter(Boolean).join(" "),
  ]);
  options.push(["-h, --help", "Print help"]);
  if (path.length === 1) options.push(["-V, --version", "Print version"]);
  sections.push(`Options:\n${table(options)}`);
  return `${sections.join("\n\n")}\n`;
}

function usageText(error: UsageError): string {
  return `error: ${error.message}\n\n${usageLine(error.path)}\n\nFor more information, try '--help'.\n`;
}

type Matched = {
  path: CommandSpec[];
  options: Map<string, string | true>;
  positionals: string[];
};

function match(argv: string[], env: Record<string, string | undefined>): Matched | Parsed {
  const path: CommandSpec[] = [ROOT];
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const command = path.at(-1) ?? ROOT;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith("--")) {
      const equals = token.indexOf("=");
      const long = token.slice(2, equals === -1 ? undefined : equals);
      if (long === "help") return { kind: "print", text: helpText(path) };
      if (long === "version" && path.length === 1) {
        return { kind: "print", text: `${VERSION_NAME} ${packageJson.version}\n` };
      }
      const spec = [...command.options, ...GLOBAL_OPTIONS].find((option) => option.long === long);
      if (!spec) throw new UsageError(`unexpected argument '${token}' found`, path);
      if (options.has(long)) {
        throw new UsageError(
          `the argument '${optionName(spec)}' cannot be used multiple times`,
          path,
        );
      }
      if (!spec.value) {
        if (equals !== -1) {
          throw new UsageError(
            `unexpected value '${token.slice(equals + 1)}' for '${optionName(spec)}' found; no more were expected`,
            path,
          );
        }
        options.set(long, true);
        continue;
      }
      let value: string | undefined;
      if (equals !== -1) value = token.slice(equals + 1);
      else {
        value = argv[index + 1];
        index += 1;
      }
      if (value === undefined) {
        throw new UsageError(
          `a value is required for '${optionName(spec)}' but none was supplied`,
          path,
        );
      }
      options.set(long, value);
      continue;
    }
    if (!literal && token.startsWith("-") && token.length > 1) {
      for (const short of token.slice(1)) {
        if (short === "h") return { kind: "print", text: helpText(path) };
        if (short === "V" && path.length === 1) {
          return { kind: "print", text: `${VERSION_NAME} ${packageJson.version}\n` };
        }
        throw new UsageError(`unexpected argument '-${short}' found`, path);
      }
      continue;
    }
    if (!literal && command.subcommands && positionals.length === 0) {
      if (token === "help") return { kind: "print", text: helpFor(path, argv.slice(index + 1)) };
      const sub = command.subcommands.find((spec) => spec.name === token);
      if (sub) {
        path.push(sub);
        continue;
      }
      if (command.args.length === 0) {
        throw new UsageError(`unrecognized subcommand '${token}'`, path);
      }
    }
    const capacity = command.args.some((arg) => arg.variadic)
      ? Number.POSITIVE_INFINITY
      : command.args.length;
    if (positionals.length >= capacity) {
      throw new UsageError(`unexpected argument '${token}' found`, path);
    }
    positionals.push(token);
  }
  const command = path.at(-1) ?? ROOT;
  if (command.subcommandRequired) {
    return { kind: "usage", text: `${helpText(path)}` };
  }
  const missing = command.args.filter((arg, at) => arg.required && positionals[at] === undefined);
  if (missing.length > 0) {
    throw new UsageError(
      `the following required arguments were not provided:\n${missing.map((arg) => `  ${argName(arg)}`).join("\n")}`,
      path,
    );
  }
  for (const spec of command.options) {
    if (!options.has(spec.long)) continue;
    if (spec.requires && !options.has(spec.requires)) {
      const needed = command.options.find((option) => option.long === spec.requires);
      throw new UsageError(
        `the following required arguments were not provided:\n  ${needed ? optionName(needed) : `--${spec.requires}`}`,
        path,
      );
    }
    if (spec.conflicts && options.has(spec.conflicts)) {
      const other = command.options.find((option) => option.long === spec.conflicts);
      throw new UsageError(
        `the argument '${optionName(spec)}' cannot be used with '${other ? optionName(other) : `--${spec.conflicts}`}'`,
        path,
      );
    }
  }
  for (const spec of GLOBAL_OPTIONS) {
    const fromEnv = spec.env ? env[spec.env] : undefined;
    if (!options.has(spec.long) && fromEnv !== undefined && fromEnv !== "") {
      options.set(`${spec.long}:env`, fromEnv);
    }
  }
  return { path, options, positionals };
}

function helpFor(path: CommandSpec[], names: string[]): string {
  const target = [...path];
  for (const name of names) {
    const sub = target.at(-1)?.subcommands?.find((spec) => spec.name === name);
    if (!sub) break;
    target.push(sub);
  }
  return helpText(target);
}

/** Parses `argv` (without the program name) the way the Rust command's clap definitions did. */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Parsed {
  let matched: Matched | Parsed;
  try {
    matched = match(argv, env);
  } catch (error) {
    if (error instanceof UsageError) return { kind: "usage", text: usageText(error) };
    throw error;
  }
  if (!("path" in matched)) return matched;
  const { path, options, positionals } = matched;
  const text = (long: string) => {
    const value = options.get(long);
    return typeof value === "string" ? value : undefined;
  };
  const flag = (long: string) => options.has(long);
  const server = text("server");
  const global: GlobalOptions = {
    server,
    serverOverridden: server !== undefined || options.has("server:env"),
    space: text("space") ?? text("space:env"),
    json: flag("json"),
  };
  const names = path.slice(1).map((spec) => spec.name);
  const [first, second] = positionals;
  const conversation = {
    newConversation: flag("new-conversation"),
    conversation: text("conversation"),
  };
  let command: Command;
  switch (names.join(" ")) {
    case "":
      command = { kind: "chat", agent: first, newConversation: false, conversation: undefined };
      break;
    case "server":
      command = { kind: "server", url: first };
      break;
    case "signup":
    case "logout":
    case "whoami":
    case "list":
    case "tui":
      command = { kind: names[0] as "signup" | "logout" | "whoami" | "list" | "tui" };
      break;
    case "login":
      command = {
        kind: "login",
        email: text("email"),
        code: flag("code"),
        passwordStdin: flag("password-stdin"),
      };
      break;
    case "send":
      command = {
        kind: "send",
        agent: first ?? "",
        message: positionals.slice(1),
        ...conversation,
      };
      break;
    case "threads list":
      command = { kind: "threadsList", agent: first ?? "" };
      break;
    case "threads show":
      command = { kind: "threadsShow", agent: first ?? "", threadId: second };
      break;
    case "approvals":
      command = { kind: "approvals", answer: undefined };
      break;
    case "approvals allow":
    case "approvals deny":
      command = {
        kind: "approvals",
        answer: { id: first ?? "", answer: names[1] === "allow" ? "allow" : "deny" },
      };
      break;
    case "workspaces create":
      command = { kind: "workspaces", command: { kind: "create", name: first ?? "" } };
      break;
    case "workspaces join":
      command = { kind: "workspaces", command: { kind: "join", link: first ?? "" } };
      break;
    case "workspaces list":
    case "workspaces invite":
    case "workspaces members":
    case "workspaces leave":
      command = {
        kind: "workspaces",
        command: { kind: names[1] as "list" | "invite" | "members" | "leave" },
      };
      break;
    case "import-bots":
      command = { kind: "importBots", file: first ?? "", dryRun: flag("dry-run") };
      break;
    case "chat":
      command = { kind: "chat", agent: first, ...conversation };
      break;
    default:
      return { kind: "usage", text: helpText(path) };
  }
  return { kind: "run", global, command };
}
