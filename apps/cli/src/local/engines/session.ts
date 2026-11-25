import { pollUntil } from "@rakazo/core";
import packageJson from "../../../package.json" with { type: "json" };
import type { Command } from "../process.js";
import type { Catalog } from "./catalog.js";
import { acpCatalog } from "./catalog.js";
import type { Engine, EngineReply } from "./engine.js";
import { at, commandBase, EngineError, field } from "./engine.js";
import {
  GrokHeadless,
  grokVersion,
  HEADLESS_VERSION,
  PROFILED_ACP_VERSION,
  profiledSession,
  scopedCommand,
} from "./grok.js";
import { appendReply, piCatalog, piPrompt, piSelect } from "./pi.js";
import type { Restricted } from "./restricted.js";
import {
  copilotPrompt,
  literalPrompt,
  openCodeMode,
  restrictedCommand,
  restrictedFor,
  selectRestrictedModel,
  verifyAgent,
  verifyRestricted,
} from "./restricted.js";
import { TURN_TIMEOUT_MS, Wire } from "./wire.js";

/** The command that starts the engine for a session, with its own arguments last. */
async function engineCommand(engine: Engine, cwd: string): Promise<Command> {
  const restricted = restrictedFor(engine);
  const command =
    engine.id === "grok"
      ? await scopedCommand(engine, cwd)
      : restricted
        ? await restrictedCommand(restricted, engine, cwd)
        : commandBase(engine, cwd);
  command.args.push(...engine.args);
  return command;
}

async function initialize(wire: Wire): Promise<unknown> {
  const response = await wire.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "superbot", version: packageJson.version },
  });
  if (at(response, "protocolVersion") !== 1) throw new EngineError("protocol");
  return response;
}

/** A signed-out engine refuses to open a session with this code. */
async function newSession(wire: Wire, params: unknown): Promise<unknown> {
  try {
    return await wire.request("session/new", params);
  } catch (error) {
    if (error instanceof EngineError && error.kind === "remote" && error.code === -32000) {
      throw new EngineError("authRequired");
    }
    throw error;
  }
}

/** Waits until the session has resolved its MCP servers and confirms it has none enabled. */
async function confirmEmptyMcp(wire: Wire, sessionId: string): Promise<void> {
  await pollUntil(
    async () => {
      const answer = await wire.request("_x.ai/mcp/list", { sessionId, cache: true });
      const catalog = at(answer, "result") ?? answer;
      const servers = at(catalog, "servers");
      if (!Array.isArray(servers)) throw new EngineError("unsafe");
      if (servers.some((server) => at(server, "session", "enabled") !== false)) {
        throw new EngineError("unsafe");
      }
      return at(catalog, "sessionMcpResolved") === true;
    },
    {
      intervalMs: 50,
      timeoutMs: 10_000,
      onTimeout: () => {
        throw new EngineError("unsafe");
      },
    },
  );
}

async function promptAcp(wire: Wire, sessionId: string, text: string): Promise<EngineReply> {
  const reply = { text: "" };
  const result = await wire.acp(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text }] },
    TURN_TIMEOUT_MS,
    (frame) => {
      if (
        at(frame, "method") !== "session/update" ||
        at(frame, "params", "sessionId") !== sessionId
      ) {
        return;
      }
      const update = at(frame, "params", "update");
      const kind = at(update, "sessionUpdate");
      if (kind === "tool_call" || kind === "tool_call_update") throw new EngineError("unsafe");
      const chunk = at(update, "content", "text");
      if (
        kind === "agent_message_chunk" &&
        at(update, "content", "type") === "text" &&
        typeof chunk === "string"
      ) {
        appendReply(reply, chunk);
      }
    },
  );
  const stopReason = field(at(result, "stopReason"));
  if (stopReason === undefined) throw new EngineError("protocol");
  return { text: reply.text, stopReason };
}

type Protocol =
  | { kind: "acp"; wire: Wire; id: string; scope: Restricted | undefined }
  | { kind: "copilot"; engine: Engine }
  | { kind: "pi"; wire: Wire }
  | { kind: "grokHeadless"; headless: GrokHeadless };

/** One prompt-only conversation with a local engine. Close it to stop the engine. */
export class EngineSession {
  readonly #protocol: Protocol;
  readonly #catalog: Catalog;
  #usable = true;

  private constructor(protocol: Protocol, catalog: Catalog) {
    this.#protocol = protocol;
    this.#catalog = catalog;
  }

  /** A session for an ordinary chat turn, on an engine that can be held to prompt-only use. */
  static async connect(engine: Engine): Promise<EngineSession> {
    const restricted = restrictedFor(engine);
    if (engine.id === "grok") {
      const version = await grokVersion(engine);
      if (version === HEADLESS_VERSION) return EngineSession.#headless(engine);
      if (version !== PROFILED_ACP_VERSION) throw new EngineError("unsafe");
    } else if (restricted) {
      return EngineSession.#restricted(engine, restricted);
    } else if (engine.protocol !== "pi") {
      throw new EngineError("unsafe");
    }
    const wire = await Wire.launch((cwd) => engineCommand(engine, cwd));
    try {
      if (engine.protocol === "pi") {
        const catalog = await piCatalog(wire);
        if (catalog.models.length === 0) throw new EngineError("authRequired");
        return new EngineSession({ kind: "pi", wire }, catalog);
      }
      const init = await initialize(wire);
      if (
        at(init, "_meta", "grokShell") !== true ||
        at(init, "_meta", "agentVersion") !== PROFILED_ACP_VERSION
      ) {
        throw new EngineError("unsafe");
      }
      const session = await newSession(wire, profiledSession(wire.cwd));
      const id = field(at(session, "sessionId"));
      if (id === undefined) throw new EngineError("protocol");
      await confirmEmptyMcp(wire, id);
      return new EngineSession({ kind: "acp", wire, id, scope: undefined }, acpCatalog(session));
    } catch (error) {
      await wire.close();
      throw error;
    }
  }

  /** A session for a private prompt, which only Grok's checked headless release can hold. */
  static async connectPrivatePrompt(engine: Engine): Promise<EngineSession> {
    if (!supportsPrivatePrompt(engine.id) || (await grokVersion(engine)) !== HEADLESS_VERSION) {
      throw new EngineError("unsafe");
    }
    return EngineSession.#headless(engine);
  }

  static async #headless(engine: Engine): Promise<EngineSession> {
    const { headless, catalog } = await GrokHeadless.connect(engine);
    return new EngineSession({ kind: "grokHeadless", headless }, catalog);
  }

  static async #restricted(engine: Engine, restricted: Restricted): Promise<EngineSession> {
    await verifyRestricted(restricted, engine);
    const wire = await Wire.launch((cwd) => engineCommand(engine, cwd));
    try {
      verifyAgent(restricted, await initialize(wire));
      const session = await newSession(wire, { cwd: wire.cwd, mcpServers: [] });
      const catalog = acpCatalog(session);
      if (catalog.models.length === 0) throw new EngineError("unknownModel");
      const id = field(at(session, "sessionId"));
      if (id === undefined) throw new EngineError("protocol");
      if (restricted === "openCode" && !openCodeMode(session)) throw new EngineError("unsafe");
      if (restricted === "copilot") {
        await wire.close();
        return new EngineSession({ kind: "copilot", engine }, catalog);
      }
      return new EngineSession({ kind: "acp", wire, id, scope: restricted }, catalog);
    } catch (error) {
      await wire.close();
      throw error;
    }
  }

  get models(): Catalog["models"] {
    return this.#catalog.models;
  }

  get currentModel(): string | undefined {
    return this.#catalog.current;
  }

  /** Sends one prompt to `model`, or the session's current model, and returns the reply. */
  async prompt(model: string | undefined, text: string): Promise<EngineReply> {
    if (!this.#usable) throw new EngineError("closed");
    const protocol = this.#protocol;
    if (model !== undefined) {
      if (!this.#catalog.models.some((entry) => entry.id === model)) {
        throw new EngineError("unknownModel");
      }
      // This release can replace a scoped profile when the session's model changes.
      if (protocol.kind === "acp" && !protocol.scope && this.#catalog.current !== model) {
        throw new EngineError("unsafe");
      }
    }
    const selected = model ?? this.#catalog.current;
    this.#usable = false;
    try {
      const reply = await this.#prompt(protocol, selected, text);
      this.#usable = true;
      return reply;
    } catch (error) {
      if (protocol.kind === "acp" || protocol.kind === "pi") protocol.wire.terminate();
      throw error;
    }
  }

  async #prompt(protocol: Protocol, model: string | undefined, text: string): Promise<EngineReply> {
    switch (protocol.kind) {
      case "acp":
        if (protocol.scope) {
          if (model !== undefined && this.#catalog.current !== model) {
            await selectRestrictedModel(protocol.scope, protocol.wire, protocol.id, model);
            this.#catalog.current = model;
          }
          return promptAcp(protocol.wire, protocol.id, literalPrompt(text));
        }
        await confirmEmptyMcp(protocol.wire, protocol.id);
        return promptAcp(protocol.wire, protocol.id, text);
      case "copilot": {
        if (model === undefined) throw new EngineError("unknownModel");
        const reply = await copilotPrompt(protocol.engine, model, text);
        this.#catalog.current = model;
        return reply;
      }
      case "pi":
        if (model !== undefined && this.#catalog.current !== model) {
          await piSelect(protocol.wire, model);
          this.#catalog.current = model;
        }
        return piPrompt(protocol.wire, text);
      case "grokHeadless": {
        if (model === undefined) throw new EngineError("unknownModel");
        const reply = await protocol.headless.prompt(model, text);
        this.#catalog.current = model;
        return reply;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#protocol.kind === "acp" || this.#protocol.kind === "pi") {
      await this.#protocol.wire.close();
    }
  }
}

/** Only Grok's checked headless release can run a prompt with nothing else in its context. */
export function supportsPrivatePrompt(provider: string): boolean {
  return provider === "grok";
}
