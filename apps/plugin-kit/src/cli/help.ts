import type { CommandSpec, OptionSpec, PositionalSpec, ValueSpec, Values } from "./commands.js";
import { ABOUT, BIN, COMMANDS, GLOBAL_OPTIONS } from "./commands.js";

type Env = Record<string, string | undefined>;

export const ROOT_USAGE = `${BIN} [OPTIONS] <COMMAND>`;

export const positionalName = (spec: PositionalSpec, used = false) =>
  spec.required || used
    ? `<${spec.value}>`
    : spec.variadic
      ? `[${spec.value}]...`
      : `[${spec.value}]`;
export const optionName = (spec: OptionSpec) => `--${spec.long} <${spec.value}>`;

/** The command's whole usage line. */
export function fullUsage(spec: CommandSpec): string {
  return [`${BIN} ${spec.name} [OPTIONS]`, ...spec.positionals.map((p) => positionalName(p))].join(
    " ",
  );
}

/**
 * The usage line naming only what was given, and with `required` the options the given values make
 * required, as shown beside a missing argument.
 */
export function givenUsage(
  spec: CommandSpec,
  values: Values,
  used: Set<string>,
  required: boolean,
): string {
  const options = commandOptions(spec).filter(
    (option) =>
      used.has(option.id) ||
      (required &&
        option.requiredIf !== undefined &&
        values[option.requiredIf[0]] === option.requiredIf[1]),
  );
  return [
    `${BIN} ${spec.name}`,
    ...options.map(optionName),
    ...(used.has("help") ? ["--help"] : []),
    ...spec.positionals.map((positional) =>
      positionalName(positional, used.has(positional.id) && !positional.variadic),
    ),
  ].join(" ");
}

/** The root usage line naming the global options given so far. */
export function rootGivenUsage(used: Set<string>): string {
  return [
    BIN,
    ...GLOBAL_OPTIONS.filter((option) => used.has(option.id)).map(optionName),
    ...["help", "version"].filter((flag) => used.has(flag)).map((flag) => `--${flag}`),
    "<COMMAND>",
  ].join(" ");
}

/** A command's own options and the global ones, in the order its help lists them. */
export function commandOptions(spec: CommandSpec): OptionSpec[] {
  const ordered: OptionSpec[] = [];
  for (let index = 0; index < Math.max(spec.options.length, GLOBAL_OPTIONS.length); index++) {
    const own = spec.options[index];
    const global = GLOBAL_OPTIONS[index];
    if (own) ordered.push(own);
    if (global) ordered.push(global);
  }
  return ordered;
}

/** A command whose choices are explained has a longer `--help` than its `-h` summary. */
export const hasLongHelp = (spec: CommandSpec) =>
  [...spec.positionals, ...spec.options].some((value) => value.choiceHelp !== undefined);

function notes(spec: ValueSpec, env: Env, withChoices: boolean): string[] {
  const option = spec as OptionSpec;
  return [
    ...(option.env ? [`[env: ${option.env}=${env[option.env] ?? ""}]`] : []),
    ...(spec.default !== undefined ? [`[default: ${spec.default}]`] : []),
    ...(withChoices && spec.choices ? [`[possible values: ${spec.choices.join(", ")}]`] : []),
  ];
}

const summary = (spec: ValueSpec, env: Env) =>
  [...(spec.help ? [spec.help] : []), ...notes(spec, env, true)].join(" ");

function details(spec: ValueSpec, env: Env): string[] {
  const lines = spec.help ? [spec.help] : [];
  if (spec.choiceHelp && spec.choices) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Possible values:",
      ...spec.choices.map((choice) => {
        const help = spec.choiceHelp?.[choice];
        return help ? `- ${choice}: ${help}` : `- ${choice}`;
      }),
    );
  }
  const rest = notes(spec, env, !spec.choiceHelp).join(" ");
  if (rest) {
    if (lines.length > 0) lines.push("");
    lines.push(rest);
  }
  return lines.length > 0 ? lines : [""];
}

function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => left.padEnd(width) + right);
}

function longTable(rows: [string, string[]][]): string[] {
  return rows.flatMap(([left, lines], index) => [
    ...(index > 0 ? [""] : []),
    left,
    ...lines.map((line) => `          ${line}`),
  ]);
}

export function rootHelp(env: Env): string {
  const commands = table([
    ...COMMANDS.map((spec): [string, string] => [
      `  ${spec.name}`,
      spec.alias ? `${spec.about} [alias: ${spec.alias}]` : spec.about,
    ]),
    ["  help", "Print this message or the help of the given subcommand(s)"],
  ]);
  const options = table([
    ...GLOBAL_OPTIONS.map((option): [string, string] => [
      `      ${optionName(option)}`,
      summary(option, env),
    ]),
    ["  -h, --help", "Print help"],
    ["  -V, --version", "Print version"],
  ]);
  return [
    ABOUT,
    "",
    `Usage: ${ROOT_USAGE}`,
    "",
    "Commands:",
    ...commands,
    "",
    "Options:",
    ...options,
    "",
  ].join("\n");
}

/** `-h` prints the summary and `--help` the long form, when the command has one. */
export function commandHelp(spec: CommandSpec, env: Env, long: boolean): string {
  const lines = [spec.about, "", `Usage: ${fullUsage(spec)}`, ""];
  const options = commandOptions(spec);
  if (long && hasLongHelp(spec)) {
    if (spec.positionals.length > 0) {
      lines.push(
        "Arguments:",
        ...longTable(spec.positionals.map((p) => [`  ${positionalName(p)}`, details(p, env)])),
        "",
      );
    }
    lines.push(
      "Options:",
      ...longTable([
        ...options.map((option): [string, string[]] => [
          `      ${optionName(option)}`,
          details(option, env),
        ]),
        ["  -h, --help", ["Print help (see a summary with '-h')"]],
      ]),
      "",
    );
    return lines.join("\n");
  }
  if (spec.positionals.length > 0) {
    lines.push(
      "Arguments:",
      ...table(spec.positionals.map((p) => [`  ${positionalName(p)}`, summary(p, env)])),
      "",
    );
  }
  lines.push(
    "Options:",
    ...table([
      ...options.map((option): [string, string] => [
        `      ${optionName(option)}`,
        summary(option, env),
      ]),
      ["  -h, --help", hasLongHelp(spec) ? "Print help (see more with '--help')" : "Print help"],
    ]),
    "",
  );
  return lines.join("\n");
}
