import { parseArgs } from "node:util";
import type { Command, CommandSpec, OptionSpec, ValueSpec, Values } from "./commands.js";
import { COMMANDS, findCommand, GLOBAL_OPTIONS, VERSION_LINE } from "./commands.js";
import {
  commandHelp,
  commandOptions,
  fullUsage,
  givenUsage,
  optionName,
  positionalName,
  ROOT_USAGE,
  rootGivenUsage,
  rootHelp,
} from "./help.js";
import { similar } from "./suggestions.js";

export type Invocation = { command: Command; server?: string; space?: string };

/** What to print and the exit status, when the command line itself decides the outcome. */
export type Exit = { code: number; stdout?: string; stderr?: string };

type Env = Record<string, string | undefined>;

class UsageError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
  }
}

function usageError({ message, usage }: UsageError): Exit {
  const lines = [`error: ${message}`, ""];
  if (usage) lines.push(`Usage: ${usage}`, "");
  lines.push("For more information, try '--help'.", "");
  return { code: 2, stderr: lines.join("\n") };
}

const choicesLine = (spec: ValueSpec) =>
  spec.choices ? `\n  [possible values: ${spec.choices.join(", ")}]` : "";

function checkValue(spec: ValueSpec, display: string, raw: string): void {
  if (spec.choices && !spec.choices.includes(raw)) {
    const best = similar(raw, spec.choices).pop();
    const tip = best === undefined ? "" : `\n\n  tip: a similar value exists: '${best}'`;
    throw new UsageError(`invalid value '${raw}' for '${display}'${choicesLine(spec)}${tip}`);
  }
  const problem = spec.check?.(raw);
  if (problem) throw new UsageError(`invalid value '${raw}' for '${display}': ${problem}`);
}

type Token = NonNullable<ReturnType<typeof parseArgs>["tokens"]>[number];
type OptionToken = Extract<Token, { kind: "option" }>;

function tokenize(args: string[], options: OptionSpec[]): Token[] {
  const config: Record<string, { type: "string" | "boolean"; short?: string }> = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "V" },
  };
  for (const option of options) config[option.long] = { type: "string" };
  return parseArgs({ args, options: config, allowPositionals: true, strict: false, tokens: true })
    .tokens;
}

/** The context a command line is read in: the root, or one command. */
type Scope = {
  options: OptionSpec[];
  /** Every long flag known here, for suggestions. */
  longs: string[];
  /** At the root, a misspelled option may be one of a command's. */
  root: boolean;
  /** The tip on passing an option-like word as a value applies where values can be given. */
  takesValues: boolean;
  usage: () => string;
  /** The usage shown for an unknown long option: what was given so far, and the suggestion. */
  usageSoFar: (suggested?: string) => string;
};

const longsOf = (spec: CommandSpec) => [...commandOptions(spec).map(({ long }) => long), "help"];

function unexpected(raw: string, scope: Scope): UsageError {
  const found = `unexpected argument '${raw}' found`;
  const valueTip = scope.takesValues
    ? `\n\n  tip: to pass '${raw}' as a value, use '-- ${raw}'`
    : "";
  if (!raw.startsWith("--")) return new UsageError(`${found}${valueTip}`, scope.usage());
  const name = raw.slice(2);
  const best = similar(name, scope.longs).pop();
  if (best !== undefined) {
    return new UsageError(
      `${found}\n\n  tip: a similar argument exists: '--${best}'`,
      scope.usageSoFar(best),
    );
  }
  if (scope.root) {
    for (const spec of COMMANDS) {
      const elsewhere = similar(name, longsOf(spec)).pop();
      if (elsewhere !== undefined) {
        return new UsageError(
          `${found}\n\n  tip: '${spec.name} --${elsewhere}' exists`,
          scope.usageSoFar(),
        );
      }
    }
  }
  return new UsageError(`${found}${valueTip}`, scope.usageSoFar());
}

/** An unknown command, with the commands and aliases it may have meant. */
function unrecognized(name: string): UsageError {
  const names = [
    ...COMMANDS.flatMap((spec) => (spec.alias ? [spec.name, spec.alias] : [spec.name])),
    "help",
  ];
  const close = similar(name, names).map((candidate) => `'${candidate}'`);
  const tip =
    close.length === 0
      ? ""
      : close.length === 1
        ? `\n\n  tip: a similar subcommand exists: ${close[0]}`
        : `\n\n  tip: some similar subcommands exist: ${close.join(", ")}`;
  return new UsageError(`unrecognized subcommand '${name}'${tip}`, ROOT_USAGE);
}

/** Reads one option's value into `values`, refusing what the parser has always refused. */
function readOption(token: OptionToken, spec: OptionSpec, values: Values, scope: Scope): void {
  const value = token.value;
  if (value !== undefined && token.inlineValue === false && /^-./.test(value)) {
    // The next word is itself an option, so this one has no value.
    const name = value.startsWith("--") ? value.slice(2).split("=", 1)[0] : undefined;
    if (!scope.options.some((option) => option.long === name)) throw unexpected(value, scope);
  }
  if (value === undefined || (token.inlineValue === false && /^-./.test(value))) {
    throw new UsageError(
      `a value is required for '${optionName(spec)}' but none was supplied${choicesLine(spec)}`,
    );
  }
  if (values[spec.id] !== undefined) {
    throw new UsageError(
      `the argument '${optionName(spec)}' cannot be used multiple times`,
      scope.usage(),
    );
  }
  checkValue(spec, optionName(spec), value);
  values[spec.id] = value;
}

const withSuggestion = (used: Set<string>, suggested: string | undefined) =>
  suggested === undefined ? used : new Set([...used, suggested]);

/**
 * Parses the command line with the commands, aliases, defaults, value ranges and messages the
 * plugin tool has always had. Global options may come before or after the command.
 */
export function parseCommandLine(argv: string[], env: Env): Invocation | Exit {
  try {
    return parseRoot(argv, env);
  } catch (error) {
    if (error instanceof UsageError) return usageError(error);
    throw error;
  }
}

function parseRoot(argv: string[], env: Env): Invocation | Exit {
  const globals: Values = {};
  const used = new Set<string>();
  const scope: Scope = {
    options: GLOBAL_OPTIONS,
    longs: [...GLOBAL_OPTIONS.map(({ long }) => long), "help", "version"],
    root: true,
    takesValues: false,
    usage: () => ROOT_USAGE,
    usageSoFar: (suggested) =>
      used.size > 0 || suggested ? rootGivenUsage(withSuggestion(used, suggested)) : ROOT_USAGE,
  };
  let terminated = false;
  for (const token of tokenize(argv, GLOBAL_OPTIONS)) {
    if (token.kind === "option-terminator") {
      terminated = true;
    } else if (token.kind === "option") {
      if (token.name === "help") return { code: 0, stdout: rootHelp(env) };
      if (token.name === "version") return { code: 0, stdout: `${VERSION_LINE}\n` };
      const spec = GLOBAL_OPTIONS.find((option) => option.long === token.name);
      if (!spec) throw unexpected(token.rawName, scope);
      readOption(token, spec, globals, scope);
      used.add(spec.id);
    } else if (terminated && findCommand(token.value)) {
      throw new UsageError(
        `unexpected argument '${token.value}' found\n\n  tip: subcommand '${token.value}' exists; to use it, remove the '--' before it`,
        ROOT_USAGE,
      );
    } else {
      const rest = argv.slice(token.index + 1);
      if (token.value === "help") return help(rest, env);
      const spec = findCommand(token.value);
      if (!spec) throw unrecognized(token.value);
      return parseCommand(spec, rest, globals, env);
    }
  }
  return { code: 2, stderr: rootHelp(env) };
}

/** `help [COMMAND]`: the long help of one command, or the overview. */
function help(args: string[], env: Env): Exit {
  const [name, extra] = args;
  if (name === undefined) return { code: 0, stdout: rootHelp(env) };
  const spec = findCommand(name);
  if (!spec) throw new UsageError(`unrecognized subcommand '${name}'`, ROOT_USAGE);
  if (extra !== undefined) {
    throw new UsageError(`unrecognized subcommand '${extra}'`, fullUsage(spec));
  }
  return { code: 0, stdout: commandHelp(spec, env, true) };
}

function parseCommand(
  spec: CommandSpec,
  args: string[],
  globals: Values,
  env: Env,
): Invocation | Exit {
  const values: Values = {};
  const scoped: Values = {};
  const used = new Set<string>();
  const scope: Scope = {
    options: commandOptions(spec),
    longs: longsOf(spec),
    root: false,
    takesValues: spec.positionals.length > 0,
    usage: () => fullUsage(spec),
    usageSoFar: (suggested) =>
      used.size > 0 || suggested
        ? givenUsage(spec, values, withSuggestion(used, suggested), false)
        : fullUsage(spec),
  };
  let next = 0;
  for (const token of tokenize(args, scope.options)) {
    if (token.kind === "option-terminator") continue;
    if (token.kind === "option") {
      if (token.name === "help") {
        return { code: 0, stdout: commandHelp(spec, env, token.rawName === "--help") };
      }
      const option = scope.options.find((candidate) => candidate.long === token.name);
      if (!option) throw unexpected(token.rawName, scope);
      readOption(token, option, GLOBAL_OPTIONS.includes(option) ? scoped : values, scope);
      used.add(option.id);
      continue;
    }
    const positional = spec.positionals[next];
    if (!positional) {
      throw new UsageError(`unexpected argument '${token.value}' found`, fullUsage(spec));
    }
    checkValue(positional, positionalName(positional), token.value);
    used.add(positional.id);
    if (positional.variadic) {
      values[positional.id] = [
        ...((values[positional.id] as string[] | undefined) ?? []),
        token.value,
      ];
    } else {
      values[positional.id] = token.value;
      next++;
    }
  }
  const missing = [
    ...spec.positionals
      .filter((positional) => positional.required && values[positional.id] === undefined)
      .map((positional) => positionalName(positional)),
    ...spec.options
      .filter(
        (option) =>
          option.requiredIf !== undefined &&
          values[option.requiredIf[0]] === option.requiredIf[1] &&
          values[option.id] === undefined,
      )
      .map(optionName),
  ];
  if (missing.length > 0) {
    throw new UsageError(
      `the following required arguments were not provided:\n${missing.map((name) => `  ${name}`).join("\n")}`,
      givenUsage(spec, values, used, true),
    );
  }
  for (const value of [...spec.positionals, ...spec.options]) {
    if (values[value.id] === undefined && value.default !== undefined) {
      values[value.id] = value.default;
    }
  }
  return {
    command: spec.build(values),
    server: (scoped.server ?? globals.server) as string | undefined,
    space: (scoped.space ?? globals.space) as string | undefined,
  };
}
