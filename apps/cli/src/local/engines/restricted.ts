import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "../process.js";
import type { Engine, EngineReply } from "./engine.js";
import { at, commandBase, EngineError, values } from "./engine.js";
import type { Wire } from "./wire.js";
import {
  inEngineDirectory,
  REQUEST_TIMEOUT_MS,
  runEngineCommand,
  TURN_TIMEOUT_MS,
} from "./wire.js";

/** Engines run prompt-only through their own switches, each pinned to the release it was checked on. */
export type Restricted = "copilot" | "gemini" | "openCode";

const RELEASES: Record<Restricted, { agent: string; version: string; versionLine: string }> = {
  copilot: { agent: "Copilot", version: "1.0.114", versionLine: "GitHub Copilot CLI 1.0.114." },
  gemini: { agent: "gemini-cli", version: "0.70.0", versionLine: "0.70.0" },
  openCode: { agent: "OpenCode", version: "1.19.6", versionLine: "1.19.6" },
};

const COPILOT_SCOPE = [
  "--available-tools=superbot_no_tools",
  "--disable-builtin-mcps",
  "--no-custom-instructions",
  "--no-experimental",
  "--sync-session=off",
  "--disallow-temp-dir",
];

export function restrictedFor(engine: Engine): Restricted | undefined {
  switch (engine.id) {
    case "githubCopilot":
      return "copilot";
    case "gemini":
      return "gemini";
    case "opencodeGo":
      return "openCode";
    default:
      return undefined;
  }
}

/** The engine with every home and configuration folder in `cwd`. */
function isolated(engine: Engine, cwd: string): Command {
  const command = commandBase(engine, cwd);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]) {
    command.env[key] = cwd;
  }
  command.env.NO_COLOR = "1";
  return command;
}

/** Text the engine would read as one of its own commands is marked as the person's message. */
export function literalPrompt(text: string): string {
  const start = text.trimStart();
  return start.startsWith("/") || start.startsWith("$") ? `User message:\n${text}` : text;
}

/** Checks the installed release, and that the program is a binary rather than a script. */
export async function verifyRestricted(restricted: Restricted, engine: Engine): Promise<void> {
  if (process.platform !== "win32" && restricted !== "gemini") {
    let header: Buffer;
    try {
      const file = await open(engine.program, "r");
      try {
        header = Buffer.alloc(2);
        const { bytesRead } = await file.read(header, 0, 2, 0);
        if (bytesRead < 2) throw new Error("short");
      } finally {
        await file.close();
      }
    } catch {
      throw new EngineError("start");
    }
    if (header.toString("latin1") === "#!") throw new EngineError("unsafe");
  }
  const version = await inEngineDirectory(async (cwd) => {
    const command = isolated(engine, cwd);
    if (restricted === "gemini") command.env.GEMINI_CLI_NO_RELAUNCH = "1";
    command.args.push("--version");
    return runEngineCommand(command, REQUEST_TIMEOUT_MS);
  });
  const { versionLine } = RELEASES[restricted];
  const supported =
    restricted === "copilot"
      ? version.split(/\r?\n/)[0] === versionLine
      : version.trim() === versionLine;
  if (!supported) throw new EngineError("unsafe");
}

/** Checks the agent the engine says it is, from its `initialize` answer. */
export function verifyAgent(restricted: Restricted, init: unknown): void {
  const { agent, version } = RELEASES[restricted];
  if (at(init, "agentInfo", "name") !== agent || at(init, "agentInfo", "version") !== version) {
    throw new EngineError("unsafe");
  }
}

async function exists(file: string): Promise<boolean | undefined> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    return undefined;
  }
}

/** The command that starts the engine with its tools, extensions and integrations switched off. */
export async function restrictedCommand(
  restricted: Restricted,
  engine: Engine,
  cwd: string,
): Promise<Command> {
  const command = isolated(engine, cwd);
  if (restricted === "copilot") {
    command.env.COPILOT_HOME = path.join(cwd, "copilot");
    command.args.push(...COPILOT_SCOPE);
  } else if (restricted === "gemini") {
    const settings = path.join(cwd, "settings.json");
    const vertex =
      process.env.GOOGLE_CLOUD_PROJECT !== undefined &&
      process.env.GEMINI_API_KEY === undefined &&
      process.env.GOOGLE_API_KEY === undefined;
    const config = {
      security: {
        auth: { selectedType: vertex ? "vertex-ai" : "gemini-api-key" },
        disableYoloMode: true,
      },
      admin: { mcp: { enabled: false }, extensions: { enabled: false } },
      tools: { core: [] },
      context: { fileName: `.superbot-context-${path.basename(cwd)}` },
      skills: { enabled: false },
      hooksConfig: { enabled: false },
      experimental: { enableAgents: false, autoMemory: false },
      telemetry: { enabled: false },
    };
    try {
      await writeFile(settings, JSON.stringify(config));
    } catch {
      throw new EngineError("start");
    }
    Object.assign(command.env, {
      GEMINI_CLI_NO_RELAUNCH: "1",
      GEMINI_CLI_HOME: path.join(cwd, "home"),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(cwd, "defaults.json"),
    });
    command.args.push("--extensions", "none");
  } else {
    // A managed configuration on this device could give the engine tools; refuse to run beside one.
    const managed =
      process.platform === "win32"
        ? "C:\\ProgramData\\opencode"
        : process.platform === "linux"
          ? "/etc/opencode"
          : undefined;
    if (managed === undefined || (await exists(managed)) !== false) throw new EngineError("unsafe");
    const programData = process.env.ProgramData;
    if (programData !== undefined && (await exists(path.join(programData, "opencode"))) !== false) {
      throw new EngineError("unsafe");
    }
    const config = {
      default_agent: "superbot-prompt",
      agent: { "superbot-prompt": { mode: "primary", permission: { "*": "deny" } } },
      permission: { "*": "deny" },
      autoupdate: false,
      share: "disabled",
      mcp: {},
      plugin: [],
      lsp: false,
    };
    Object.assign(command.env, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    });
  }
  return command;
}

/** OpenCode runs a session in the prompt-only agent mode it was configured with. */
export function openCodeMode(session: unknown): boolean {
  return values(at(session, "configOptions")).some(
    (option) => at(option, "id") === "mode" && at(option, "currentValue") === "superbot-prompt",
  );
}

export async function selectRestrictedModel(
  restricted: Restricted,
  wire: Wire,
  sessionId: string,
  model: string,
): Promise<void> {
  if (restricted === "gemini") {
    await wire.request("session/set_model", { sessionId, modelId: model });
    return;
  }
  if (restricted === "openCode") {
    const response = await wire.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: model,
    });
    if (!openCodeMode(response)) throw new EngineError("unsafe");
    const selected = values(at(response, "configOptions")).some(
      (option) => at(option, "id") === "model" && at(option, "currentValue") === model,
    );
    if (!selected) throw new EngineError("unknownModel");
    return;
  }
  throw new EngineError("unsupported");
}

/** Copilot answers one prompt per process, in its silent prompt mode. */
export async function copilotPrompt(
  engine: Engine,
  model: string,
  text: string,
): Promise<EngineReply> {
  if (Buffer.byteLength(text) > 24_000 || text.includes("\0")) throw new EngineError("limit");
  return inEngineDirectory(async (cwd) => {
    const command = await restrictedCommand("copilot", engine, cwd);
    command.args.push("--silent", `--model=${model}`, `--prompt=${literalPrompt(text)}`);
    const reply = (await runEngineCommand(command, TURN_TIMEOUT_MS)).trimEnd();
    if (reply === "") throw new EngineError("protocol");
    return { text: reply, stopReason: "end_turn" };
  });
}
