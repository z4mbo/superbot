import { randomUUID } from "node:crypto";
import type { Client } from "@rakazo/cli-client";
import { retry } from "@rakazo/core";
import {
  authHint,
  CommandError,
  hasStatus,
  hinted,
  isRetryable,
  withContext,
} from "../output/errors.js";
import { escapeDebug } from "../output/text.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";
import type { AppContext, AppPin, AppValues, GrantedApps } from "./app-records.js";
import {
  addLocalAppRecord,
  localRecordApps,
  localRecordContext,
  suggestAppRecord,
} from "./app-records.js";
import type { LocalModelDrivers } from "./local-model.js";
import { supportsAppAssistance } from "./local-model.js";
import { LocalModelError } from "./local-model-error.js";
import type { InstalledModel, LocalModelStore } from "./local-model-store.js";

/** `/apps` and `/app ...` lines, which stay outside the conversation. */
export function isAppCommand(input: string): boolean {
  const first = input.split(/\s+/).find((word) => word !== "");
  return first === "/apps" || first === "/app";
}

/** The first word and the rest with its leading whitespace removed. */
function splitWord(input: string): [string, string] {
  const at = input.search(/\s/);
  if (at === -1) return [input, ""];
  return [input.slice(0, at), input.slice(at + 1).trimStart()];
}

/** `/app NUMBER [--date YYYY-MM-DD] [REQUEST]`, or undefined for anything else. */
export function appRequest(
  input: string,
): { number: number; date: string | undefined; request: string } | undefined {
  const [command, args] = splitWord(input);
  if (command !== "/app") return undefined;
  const [number, rest] = splitWord(args);
  if (!/^\+?\d+$/.test(number)) return undefined;
  const [flag, tail] = splitWord(rest);
  if (flag === "--date") {
    const [date, request] = splitWord(tail);
    return { number: Number(number), date, request };
  }
  return { number: Number(number), date: undefined, request: rest };
}

function printValues(io: Io, context: AppContext, values: Record<string, unknown>): void {
  for (const field of context.app.part.fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    const display = typeof value === "string" ? `"${escapeDebug(value, false)}"` : String(value);
    line(io, `  ${escapeDebug(field.label)} (${field.id}): ${display}`);
  }
}

function printContext(io: Io, context: AppContext, date: string | undefined): void {
  line(io, `${escapeDebug(context.app.pluginName)} (${context.app.part.id})`);
  if (date !== undefined) line(io, `Date filter: ${escapeDebug(date)}`);
  if (context.items.length === 0) line(io, "No records in this preview.");
  context.items.forEach((record, index) => {
    line(io, `Record ${index + 1}:`);
    printValues(io, context, record.values);
  });
  if (context.total !== null) {
    const label =
      context.app.part.fields.find((field) => field.id === context.app.part.summaryField)?.label ??
      "Value";
    line(io, `${escapeDebug(label)} total: ${context.total}`);
  }
  if (context.hasMore) line(io, "More records are available in the app.");
}

type ApprovedAddition = { pin: AppPin; id: string; values: AppValues };

/** Record app help with a local model: list granted apps, preview records and save approved drafts. */
export class LocalAppChat {
  readonly #io: Io;
  readonly #drivers: LocalModelDrivers;
  #page: GrantedApps | undefined;
  #approved: ApprovedAddition | undefined;

  constructor(io: Io, drivers: LocalModelDrivers) {
    this.#io = io;
    this.#drivers = drivers;
  }

  async handle(
    client: Client,
    spaceId: string,
    botId: string,
    store: LocalModelStore,
    selected: InstalledModel | undefined,
    input: string,
  ): Promise<void> {
    const io = this.#io;
    if (input === "/app retry") return this.#save(client, spaceId, botId);
    if (input === "/app discard") {
      if (this.#approved) line(io, "Cleared the pending save from this session.");
      this.#approved = undefined;
      return;
    }
    const model = selected && supportsAppAssistance(selected) ? selected : undefined;
    if (!model)
      throw new CommandError("App assistance requires a selected prompt-only local model.");
    if (input === "/apps" || input === "/apps next") {
      let after: string | undefined;
      if (input === "/apps next") {
        after = this.#page?.nextAfter ?? undefined;
        if (after === undefined) {
          line(io, "No next page. Type /apps to start from the first page.");
          return;
        }
      }
      let page: GrantedApps;
      try {
        page = await localRecordApps(client, spaceId, botId, after);
      } catch (error) {
        if (hasStatus(error, 404)) {
          throw new CommandError("This server doesn't support local app assistance.");
        }
        throw authHint(error);
      }
      page.items.forEach((app, index) => {
        line(io, `${index + 1}. ${escapeDebug(app.pluginName)} (${app.part.id})`);
      });
      if (page.items.length === 0) line(io, "No granted record apps on this page.");
      else line(io, "Use /app NUMBER to view records or /app NUMBER REQUEST for local help.");
      if (page.nextAfter !== null) line(io, "Use /apps next for more apps.");
      this.#page = page;
      return;
    }
    const parsed = appRequest(input);
    if (!parsed)
      throw new CommandError("Use /apps, then /app NUMBER [--date YYYY-MM-DD] [REQUEST]");
    const app = parsed.number >= 1 ? this.#page?.items[parsed.number - 1] : undefined;
    if (!app) throw new CommandError("Choose an app number from /apps.");
    const context = await hinted(localRecordContext(client, spaceId, botId, app.pin, parsed.date));
    printContext(io, context, parsed.date);
    if (parsed.request === "") return;
    if (this.#approved) {
      throw new CommandError(
        "Use /app retry to finish the approved save or /app discard to stop retrying it.",
      );
    }
    let result: Awaited<ReturnType<typeof suggestAppRecord>>;
    try {
      result = await suggestAppRecord(
        this.#drivers,
        store,
        model,
        context,
        parsed.date,
        parsed.request,
      );
    } catch (error) {
      if (error instanceof LocalModelError) throw new CommandError(error.message);
      throw error;
    }
    line(io, `Local answer > ${escapeDebug(result.answer)}`);
    if (!result.addition) return;
    line(io, `Proposed addition to ${escapeDebug(context.app.pluginName)}:`);
    printValues(io, context, result.addition);
    if ((await io.prompt("Type save to approve this addition (Enter to skip): ")) === "save") {
      this.#approved = { pin: context.app.pin, id: randomUUID(), values: result.addition };
      await this.#save(client, spaceId, botId);
    }
  }

  async #save(client: Client, spaceId: string, botId: string): Promise<void> {
    const addition = this.#approved;
    if (!addition) {
      line(this.#io, "No approved app addition is waiting to be saved.");
      return;
    }
    try {
      await retry(
        () => addLocalAppRecord(client, spaceId, botId, addition.pin, addition.id, addition.values),
        { attempts: 2, delayMs: 0, retryable: isRetryable },
      );
    } catch (error) {
      if (hasStatus(error, 400, 403, 409)) {
        this.#approved = undefined;
        throw withContext("The server rejected the app addition", authHint(error));
      }
      throw withContext(
        "Could not confirm the app save. Use /app retry in this session to retry it",
        authHint(error),
      );
    }
    this.#approved = undefined;
    line(this.#io, "Record saved.");
  }
}
