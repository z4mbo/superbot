import type { Catalog } from "./catalog.js";
import { dedupCatalog } from "./catalog.js";
import type { EngineReply } from "./engine.js";
import { at, EngineError, field, values } from "./engine.js";
import type { Wire } from "./wire.js";
import { REQUEST_TIMEOUT_MS, TURN_TIMEOUT_MS, within } from "./wire.js";

const MAX_REPLY = 4 * 1024 * 1024;

const TOOL_EVENTS = new Set([
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "extension_ui_request",
]);

/** A frame that shows the engine running a tool or extension, which a prompt-only turn refuses. */
function rejectToolEvent(frame: unknown): void {
  const type = at(frame, "type");
  if (typeof type === "string" && TOOL_EVENTS.has(type)) throw new EngineError("unsafe");
}

async function response(wire: Wire, command: string): Promise<unknown> {
  for (;;) {
    const frame = await wire.read();
    if (at(frame, "type") === "response") {
      if (at(frame, "id") !== command || at(frame, "command") !== command) {
        throw new EngineError("protocol");
      }
      if (at(frame, "success") !== true) throw new EngineError("remote", 0);
      return frame;
    }
    rejectToolEvent(frame);
  }
}

export function appendReply(reply: { text: string }, chunk: string): void {
  if (Buffer.byteLength(reply.text) + Buffer.byteLength(chunk) > MAX_REPLY) {
    throw new EngineError("limit");
  }
  reply.text += chunk;
}

export function piCatalog(wire: Wire): Promise<Catalog> {
  return within(
    REQUEST_TIMEOUT_MS,
    (async () => {
      await wire.write({ id: "get_available_models", type: "get_available_models" });
      const answer = await response(wire, "get_available_models");
      const catalog: Catalog = {
        current: undefined,
        models: values(at(answer, "data", "models")).flatMap((entry) => {
          const provider = field(at(entry, "provider"));
          const model = field(at(entry, "id"));
          if (provider === undefined || model === undefined) return [];
          return [
            { id: `${provider}/${model}`, label: field(at(entry, "name")) ?? model, provider },
          ];
        }),
      };
      dedupCatalog(catalog);
      await wire.write({ id: "get_state", type: "get_state" });
      const state = await response(wire, "get_state");
      const provider = field(at(state, "data", "model", "provider"));
      const id = field(at(state, "data", "model", "id"));
      catalog.current =
        provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
      return catalog;
    })(),
  );
}

export function piSelect(wire: Wire, model: string): Promise<void> {
  const slash = model.indexOf("/");
  if (slash === -1) throw new EngineError("unknownModel");
  return within(
    REQUEST_TIMEOUT_MS,
    (async () => {
      await wire.write({
        id: "set_model",
        type: "set_model",
        provider: model.slice(0, slash),
        modelId: model.slice(slash + 1),
      });
      await response(wire, "set_model");
    })(),
  );
}

export function piPrompt(wire: Wire, text: string): Promise<EngineReply> {
  return within(
    TURN_TIMEOUT_MS,
    (async () => {
      await wire.write({ id: "prompt", type: "prompt", message: text });
      let acknowledged = false;
      const reply = { text: "" };
      for (;;) {
        const frame = await wire.read();
        rejectToolEvent(frame);
        const type = at(frame, "type");
        if (type === "response") {
          if (at(frame, "id") !== "prompt" || at(frame, "command") !== "prompt") {
            throw new EngineError("protocol");
          }
          if (at(frame, "success") !== true) throw new EngineError("remote", 0);
          acknowledged = true;
        } else if (
          type === "message_update" &&
          at(frame, "assistantMessageEvent", "type") === "text_delta"
        ) {
          const chunk = at(frame, "assistantMessageEvent", "delta");
          if (typeof chunk === "string") appendReply(reply, chunk);
        } else if (type === "agent_end" && acknowledged && at(frame, "willRetry") !== true) {
          const message = values(at(frame, "messages"))
            .filter((entry) => at(entry, "role") === "assistant")
            .at(-1);
          const reason = field(at(message, "stopReason"));
          if (reason === undefined) throw new EngineError("protocol");
          if (reason === "error") throw new EngineError("remote", 0);
          if (reason === "toolUse") throw new EngineError("unsafe");
          if (reply.text === "") {
            for (const part of values(at(message, "content"))) {
              const partText = at(part, "text");
              if (at(part, "type") === "text" && typeof partText === "string") {
                appendReply(reply, partText);
              }
            }
          }
          return { text: reply.text, stopReason: reason };
        }
      }
    })(),
  );
}
