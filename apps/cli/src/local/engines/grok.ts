import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "../process.js";
import type { Catalog } from "./catalog.js";
import { dedupCatalog } from "./catalog.js";
import type { Engine, EngineReply } from "./engine.js";
import { at, commandBase, EngineError, field } from "./engine.js";
import {
  inEngineDirectory,
  REQUEST_TIMEOUT_MS,
  runEngineCommand,
  TURN_TIMEOUT_MS,
} from "./wire.js";

const MAX_OUTPUT = 4 * 1024 * 1024;
/** The release whose headless mode can be held to one prompt-only turn. */
export const HEADLESS_VERSION = "1.0.89";
/** The release whose ACP mode accepts the prompt-only profile. */
export const PROFILED_ACP_VERSION = "1.0.41";

async function authPath(): Promise<string | undefined> {
  const home =
    process.env.GROK_HOME ??
    ((process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) &&
      path.join(
        (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) as string,
        ".grok",
      ));
  if (!home) return undefined;
  const file = path.join(home, "auth.json");
  if (!path.isAbsolute(file)) return undefined;
  return (await stat(file).catch(() => undefined))?.isFile() ? file : undefined;
}

/** The engine with its own home, configuration, memory and integrations kept in `cwd`. */
export async function scopedCommand(engine: Engine, cwd: string): Promise<Command> {
  const command = commandBase(engine, cwd);
  Object.assign(command.env, {
    HOME: cwd,
    USERPROFILE: cwd,
    APPDATA: cwd,
    LOCALAPPDATA: cwd,
    XDG_CONFIG_HOME: cwd,
    XDG_DATA_HOME: cwd,
    XDG_CACHE_HOME: cwd,
    GROK_HOME: cwd,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CURSOR_HOOKS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_MEMORY: "0",
  });
  const auth = await authPath();
  if (auth) command.env.GROK_AUTH_PATH = auth;
  return command;
}

/** The installed release, from `--version`; another program under this name is unsupported. */
export async function grokVersion(engine: Engine): Promise<string> {
  return inEngineDirectory(async (cwd) => {
    const command = commandBase(engine, cwd);
    command.args.push("--version");
    const fields = (await runEngineCommand(command, REQUEST_TIMEOUT_MS))
      .split(/\s+/)
      .filter(Boolean);
    if (fields[0] !== "grok") throw new EngineError("unsupported");
    const version = fields[1];
    if (version === undefined) throw new EngineError("protocol");
    return version;
  });
}

const validId = (id: string) => id !== "" && !id.startsWith("-") && /^[A-Za-z0-9\-_./:]+$/.test(id);

/** The model list `grok models` prints; a signed-out engine lists none it can use. */
export function parseModels(output: string): Catalog & { needsAuth: boolean } {
  const catalog: Catalog = { models: [], current: undefined };
  let inCatalog = false;
  let needsAuth = false;
  for (const row of output.split("\n").map((text) => text.trim())) {
    if (row === "You are not authenticated.") needsAuth = true;
    else if (row.startsWith("Default model: ") && validId(row.slice("Default model: ".length))) {
      catalog.current = row.slice("Default model: ".length);
    } else if (row === "Available models:") inCatalog = true;
    else if (inCatalog) {
      const listed = row.startsWith("* ") || row.startsWith("- ") ? row.slice(2) : undefined;
      const id = listed?.split(/\s+/)[0];
      if (id && validId(id)) catalog.models.push({ id, label: id });
    }
  }
  if (!inCatalog || catalog.models.length === 0) throw new EngineError("protocol");
  dedupCatalog(catalog);
  return { ...catalog, needsAuth };
}

/** Grok's headless mode: one turn per process, each checked to run with nothing but the prompt. */
export class GrokHeadless {
  readonly #engine: Engine;

  private constructor(engine: Engine) {
    this.#engine = engine;
  }

  static async connect(engine: Engine): Promise<{ headless: GrokHeadless; catalog: Catalog }> {
    const headless = new GrokHeadless(engine);
    const probe = await inEngineDirectory(async (cwd) => {
      await headless.#checkScope(cwd);
      const command = await headless.#command(cwd);
      command.args.push("models");
      return parseModels(await runEngineCommand(command, REQUEST_TIMEOUT_MS));
    });
    if (probe.needsAuth) throw new EngineError("authRequired");
    return { headless, catalog: { models: probe.models, current: probe.current } };
  }

  async prompt(model: string, text: string): Promise<EngineReply> {
    return inEngineDirectory(async (cwd) => {
      await this.#checkScope(cwd);
      if (Buffer.byteLength(text) > MAX_OUTPUT) throw new EngineError("limit");
      const file = path.join(cwd, "prompt.txt");
      try {
        await writeFile(file, text);
      } catch {
        throw new EngineError("start");
      }
      const command = await this.#command(cwd);
      command.args.push(
        "--model",
        model,
        "--verbatim",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--deny",
        "Bash,Read,Edit,Write,Grep,WebFetch,MCPTool",
        "--sandbox",
        "strict",
        "--no-subagents",
        "--disable-web-search",
        "--no-plan",
        "--tools",
        "read_file",
        "--disallowed-tools",
        "read_file,hashline_read,search_tool,use_tool,Agent",
        "--prompt-file",
        file,
      );
      let result: unknown;
      try {
        result = JSON.parse(await runEngineCommand(command, TURN_TIMEOUT_MS));
      } catch (error) {
        if (error instanceof EngineError) throw error;
        throw new EngineError("protocol");
      }
      const reply = at(result, "text");
      const stopReason = field(at(result, "stopReason"));
      if (typeof reply !== "string" || stopReason === undefined) throw new EngineError("protocol");
      if (["tool_use", "toolUse", "error"].includes(stopReason)) throw new EngineError("unsafe");
      return { text: reply, stopReason };
    });
  }

  /** Refuses a release or profile with hooks, skills, plugins, servers or instructions of its own. */
  async #checkScope(cwd: string): Promise<void> {
    const command = await this.#command(cwd);
    command.args.push("inspect", "--json");
    let inspection: unknown;
    try {
      inspection = JSON.parse(await runEngineCommand(command, REQUEST_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("protocol");
    }
    const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
    const scoped =
      at(inspection, "grokVersion") === HEADLESS_VERSION &&
      [
        "hooks",
        "skills",
        "plugins",
        "marketplaces",
        "mcpServers",
        "lspServers",
        "projectInstructions",
      ].every((key) => empty(at(inspection, key))) &&
      empty(at(inspection, "configSources", "layers"));
    if (!scoped) throw new EngineError("unsafe");
  }

  async #command(cwd: string): Promise<Command> {
    const command = await scopedCommand(this.#engine, cwd);
    Object.assign(command.env, { TEMP: cwd, TMP: cwd, TMPDIR: cwd, XDG_RUNTIME_DIR: cwd });
    delete command.env.DBUS_SESSION_BUS_ADDRESS;
    return command;
  }
}

/** The prompt-only profile Grok's ACP mode runs a session with. */
export function profiledSession(cwd: string): unknown {
  // This release rejects an empty curated profile; its denied placeholder keeps the tool set empty.
  return {
    cwd,
    mcpServers: [],
    _meta: {
      agentProfile: {
        name: "superbot-prompt",
        description: "Prompt only",
        injectDefaultTools: false,
        discoverSkills: false,
        toolConfig: { tools: [{ id: "GrokBuild:read_file", name_override: "read_file" }] },
        tools: [],
        disallowedTools: ["read_file"],
      },
    },
  };
}
