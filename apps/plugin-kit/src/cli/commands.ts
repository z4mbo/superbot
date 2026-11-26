import packageJson from "../../package.json" with { type: "json" };

export const BIN = "superbot-plugin";
/** `--version` prints the package name, as the tool always has. */
export const VERSION_LINE = `${packageJson.name} ${packageJson.version}`;
export const ABOUT = "Develop plugins for the Superbot registry";

export const TEMPLATES = ["skill", "mcp-app", "kcal-diary"] as const;
export type Template = (typeof TEMPLATES)[number];
export const LIST_SCOPES = ["discover", "mine", "installations", "submissions"] as const;
export type ListScope = (typeof LIST_SCOPES)[number];
export const STATUSES = ["pending", "approved", "rejected"] as const;
export type Status = (typeof STATUSES)[number];
export const DECISIONS = ["approved", "rejected"] as const;
export type Decision = (typeof DECISIONS)[number];

/** A parsed command line, typed as each command takes it. */
export type Command =
  | { kind: "init"; slug: string; name?: string; manifest: string; template: Template }
  | { kind: "validate"; manifest: string }
  | { kind: "app-init"; folder: string; name?: string }
  | { kind: "app-check"; folder: string }
  | { kind: "app-publish"; folder: string }
  | { kind: "publish"; slug: string; version: number; manifest: string }
  | {
      kind: "list";
      scope: ListScope;
      after?: string;
      limit: number;
      slug?: string;
      query?: string;
      status?: Status;
    }
  | { kind: "status"; versionId: string }
  | { kind: "agents" }
  | { kind: "install"; versionId: string }
  | {
      kind: "switch-version";
      installationId: string;
      expectedVersionId: string;
      versionId: string;
    }
  | { kind: "set-grants"; installationId: string; botId: string; partIds: string[] }
  | { kind: "uninstall"; installationId: string }
  | { kind: "review"; versionId: string; decision: Decision; reason?: string };

export type Values = Record<string, string | string[] | undefined>;

export type ValueSpec = {
  /** The key the value is stored under. */
  id: string;
  /** The placeholder shown in usage, such as `SLUG`. */
  value: string;
  help?: string;
  default?: string;
  choices?: readonly string[];
  /** Choices explained in the long help. */
  choiceHelp?: Record<string, string>;
  /** The typed parser's objection to a value, if any. */
  check?: (raw: string) => string | undefined;
};
export type PositionalSpec = ValueSpec & { required?: boolean; variadic?: boolean };
export type OptionSpec = ValueSpec & {
  long: string;
  env?: string;
  requiredIf?: [id: string, value: string];
};
export type CommandSpec = {
  name: Command["kind"];
  alias?: string;
  about: string;
  positionals: PositionalSpec[];
  options: OptionSpec[];
  build: (values: Values) => Command;
};

/** Integers as the version and page size parsers take them: a sign, digits, then the range. */
function integer(min: number, max: number, unsigned: boolean) {
  return (raw: string): string | undefined => {
    if (raw === "") return "cannot parse integer from empty string";
    if (!(unsigned ? /^\+?[0-9]+$/ : /^[+-]?[0-9]+$/).test(raw)) {
      return "invalid digit found in string";
    }
    const value = BigInt(raw);
    if (value > (unsigned ? 18446744073709551615n : 9223372036854775807n)) {
      return "number too large to fit in target type";
    }
    if (value < -9223372036854775808n) return "number too small to fit in target type";
    return value < BigInt(min) || value > BigInt(max)
      ? `${value} is not in ${min}..=${max}`
      : undefined;
  };
}

const MANIFEST_OPTION: OptionSpec = {
  id: "manifest",
  long: "manifest",
  value: "MANIFEST",
  default: "plugin.json",
};

const text = (values: Values, id: string) => values[id] as string;
const optional = (values: Values, id: string) => values[id] as string | undefined;

export const COMMANDS: CommandSpec[] = [
  {
    name: "init",
    alias: "scaffold",
    about: "Create a starter skill, TypeScript MCP app or record app",
    positionals: [{ id: "slug", value: "SLUG", required: true }],
    options: [
      { id: "name", long: "name", value: "NAME" },
      MANIFEST_OPTION,
      {
        id: "template",
        long: "template",
        value: "TEMPLATE",
        default: "skill",
        choices: TEMPLATES,
        choiceHelp: {
          "kcal-diary":
            "A record app: a calorie diary whose meals the registry keeps per installation",
        },
      },
    ],
    build: (values) => ({
      kind: "init",
      slug: text(values, "slug"),
      name: optional(values, "name"),
      manifest: text(values, "manifest"),
      template: text(values, "template") as Template,
    }),
  },
  {
    name: "validate",
    about: "Validate a manifest locally",
    positionals: [{ id: "manifest", value: "MANIFEST", default: "plugin.json" }],
    options: [],
    build: (values) => ({ kind: "validate", manifest: text(values, "manifest") }),
  },
  {
    name: "publish",
    alias: "submit",
    about: "Submit a new version for review",
    positionals: [
      { id: "slug", value: "SLUG", required: true },
      { id: "version", value: "VERSION", required: true, check: integer(1, 2147483647, false) },
    ],
    options: [MANIFEST_OPTION],
    build: (values) => ({
      kind: "publish",
      slug: text(values, "slug"),
      version: Number(text(values, "version")),
      manifest: text(values, "manifest"),
    }),
  },
  {
    name: "app-init",
    about: "Create an app folder with hosted records, server functions and a card",
    positionals: [
      {
        id: "folder",
        value: "FOLDER",
        required: true,
        help: "The new folder; its name becomes the app id",
      },
    ],
    options: [{ id: "name", long: "name", value: "NAME" }],
    build: (values) => ({
      kind: "app-init",
      folder: text(values, "folder"),
      name: optional(values, "name"),
    }),
  },
  {
    name: "app-check",
    about: "Check an app folder as the server will",
    positionals: [{ id: "folder", value: "FOLDER", default: "." }],
    options: [],
    build: (values) => ({ kind: "app-check", folder: text(values, "folder") }),
  },
  {
    name: "app-publish",
    about: "Submit an app folder's version for review",
    positionals: [{ id: "folder", value: "FOLDER", default: "." }],
    options: [],
    build: (values) => ({ kind: "app-publish", folder: text(values, "folder") }),
  },
  {
    name: "list",
    about: "List approved versions, your submissions, installations, or the reviewer queue",
    positionals: [{ id: "scope", value: "SCOPE", default: "discover", choices: LIST_SCOPES }],
    options: [
      { id: "after", long: "after", value: "AFTER" },
      { id: "limit", long: "limit", value: "LIMIT", default: "20", check: integer(1, 50, true) },
      { id: "slug", long: "slug", value: "SLUG", help: "Filter approved versions by slug" },
      {
        id: "query",
        long: "query",
        value: "QUERY",
        help: "Search approved versions by slug, name, or description",
      },
      {
        id: "status",
        long: "status",
        value: "STATUS",
        choices: STATUSES,
        help: "Filter the reviewer queue by status",
      },
    ],
    build: (values) => ({
      kind: "list",
      scope: text(values, "scope") as ListScope,
      after: optional(values, "after"),
      limit: Number(text(values, "limit")),
      slug: optional(values, "slug"),
      query: optional(values, "query"),
      status: optional(values, "status") as Status | undefined,
    }),
  },
  {
    name: "status",
    about: "Look up one of your submitted versions by ID",
    positionals: [{ id: "versionId", value: "VERSION_ID", required: true }],
    options: [],
    build: (values) => ({ kind: "status", versionId: text(values, "versionId") }),
  },
  {
    name: "agents",
    about: "List Space agents and their IDs for grants",
    positionals: [],
    options: [],
    build: () => ({ kind: "agents" }),
  },
  {
    name: "install",
    about: "Install an approved version in the Space",
    positionals: [{ id: "versionId", value: "VERSION_ID", required: true }],
    options: [],
    build: (values) => ({ kind: "install", versionId: text(values, "versionId") }),
  },
  {
    name: "switch-version",
    about: "Switch an installation to an approved version and clear all of its grants",
    positionals: [
      { id: "installationId", value: "INSTALLATION_ID", required: true },
      { id: "expectedVersionId", value: "EXPECTED_VERSION_ID", required: true },
      { id: "versionId", value: "VERSION_ID", required: true },
    ],
    options: [],
    build: (values) => ({
      kind: "switch-version",
      installationId: text(values, "installationId"),
      expectedVersionId: text(values, "expectedVersionId"),
      versionId: text(values, "versionId"),
    }),
  },
  {
    name: "set-grants",
    alias: "grant",
    about: "Replace one agent's grants. Omit part IDs to revoke all grants for that agent",
    positionals: [
      { id: "installationId", value: "INSTALLATION_ID", required: true },
      { id: "botId", value: "BOT_ID", required: true },
      { id: "partIds", value: "PART_IDS", variadic: true },
    ],
    options: [],
    build: (values) => ({
      kind: "set-grants",
      installationId: text(values, "installationId"),
      botId: text(values, "botId"),
      partIds: (values.partIds as string[] | undefined) ?? [],
    }),
  },
  {
    name: "uninstall",
    about: "Remove an installation and its grants",
    positionals: [{ id: "installationId", value: "INSTALLATION_ID", required: true }],
    options: [],
    build: (values) => ({ kind: "uninstall", installationId: text(values, "installationId") }),
  },
  {
    name: "review",
    about: "Approve or reject a pending submission as a deployment admin",
    positionals: [
      { id: "versionId", value: "VERSION_ID", required: true },
      { id: "decision", value: "DECISION", required: true, choices: DECISIONS },
    ],
    options: [
      { id: "reason", long: "reason", value: "REASON", requiredIf: ["decision", "rejected"] },
    ],
    build: (values) => ({
      kind: "review",
      versionId: text(values, "versionId"),
      decision: text(values, "decision") as Decision,
      reason: optional(values, "reason"),
    }),
  },
];

/** Options every command takes, before or after the command name. */
export const GLOBAL_OPTIONS: OptionSpec[] = [
  { id: "server", long: "server", value: "SERVER", env: "SUPERBOT_SERVER" },
  { id: "space", long: "space", value: "SPACE", help: "Select a Space by exact name or ID" },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((spec) => spec.name === name || spec.alias === name);
}
