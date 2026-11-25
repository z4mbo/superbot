import type { Client } from "@rakazo/cli-client";
import type { RpcInput, RpcOutput } from "@rakazo/contracts";
import { appRecordsPrompt } from "./app-records.prompt.js";
import type { LocalModelDrivers } from "./local-model.js";
import { LocalModelError } from "./local-model-error.js";
import type { InstalledModel, LocalModelStore } from "./local-model-store.js";

export type GrantedApps = RpcOutput<"localAppRecords/list">;
export type GrantedApp = GrantedApps["items"][number];
export type AppPin = GrantedApp["pin"];
export type AppContext = RpcOutput<"localAppRecords/context">;
export type AppPart = GrantedApp["part"];
/** Record values by field ID. */
export type AppValues = Record<string, string | number>;

export function localRecordApps(client: Client, spaceId: string, botId: string, after?: string) {
  const input: RpcInput<"localAppRecords/list"> =
    after === undefined ? { botId } : { botId, after };
  return client.rpc("localAppRecords/list", spaceId, input);
}

export function localRecordContext(
  client: Client,
  spaceId: string,
  botId: string,
  app: AppPin,
  date: string | undefined,
) {
  const input: RpcInput<"localAppRecords/context"> =
    date === undefined ? { botId, app } : { botId, app, date };
  return client.rpc("localAppRecords/context", spaceId, input);
}

/** Saves an approved record; retries reuse the same pin, operation ID and values. */
export function addLocalAppRecord(
  client: Client,
  spaceId: string,
  botId: string,
  app: AppPin,
  operationId: string,
  values: AppValues,
) {
  return client.rpc("localAppRecords/add", spaceId, {
    botId,
    app,
    operationId,
    values,
  } as RpcInput<"localAppRecords/add">);
}

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_ANSWER_BYTES = 4 * 1024;

export type AppSuggestion = { answer: string; addition: AppValues | null };

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Values keyed in the order Rust's sorted maps gave them. */
function sortedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Runs a prompt-only turn with one app's context. The result is a local draft. */
export async function suggestAppRecord(
  drivers: LocalModelDrivers,
  store: LocalModelStore,
  model: InstalledModel,
  context: AppContext,
  date: string | undefined,
  request: string,
): Promise<AppSuggestion> {
  if (request.trim() === "" || bytes(request) > MAX_REQUEST_BYTES) {
    throw new LocalModelError("Enter an app request of up to 4 KiB.");
  }
  const data = {
    request,
    appName: context.app.pluginName,
    fields: context.app.part.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
    })),
    dateFilter: date ?? null,
    records: context.items.map((record) => sortedValues(record.values)),
    summaryField: context.app.part.summaryField ?? null,
    total: context.total,
    hasMore: context.hasMore,
  };
  const prompt = appRecordsPrompt(data);
  if (bytes(prompt) > MAX_PROMPT_BYTES) {
    throw new LocalModelError("The app context is too large for local assistance.");
  }
  const reply = await drivers.run(store, model, prompt, "appRecords");
  if (bytes(reply) > MAX_REPLY_BYTES)
    throw new LocalModelError("The local app reply was too large.");
  const invalid = () => new LocalModelError("The local model didn't return a valid app answer.");
  let result: unknown;
  try {
    result = JSON.parse(reply);
  } catch {
    throw invalid();
  }
  const suggestion = parseSuggestion(result);
  if (!suggestion) throw invalid();
  if (suggestion.answer.trim() === "" || bytes(suggestion.answer) > MAX_ANSWER_BYTES)
    throw invalid();
  if (suggestion.addition && !validAddition(context.app.part, suggestion.addition)) {
    throw new LocalModelError("The suggested addition doesn't match the app fields.");
  }
  return suggestion;
}

/** Exactly `answer` and an optional `addition` of text and number values; nothing else. */
function parseSuggestion(value: unknown): AppSuggestion | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "answer" && key !== "addition")) return undefined;
  if (typeof fields.answer !== "string") return undefined;
  const addition = fields.addition;
  if (addition === undefined || addition === null) return { answer: fields.answer, addition: null };
  if (typeof addition !== "object" || Array.isArray(addition)) return undefined;
  const values: AppValues = {};
  for (const [key, entry] of Object.entries(addition)) {
    if (typeof entry !== "string" && typeof entry !== "number") return undefined;
    values[key] = entry;
  }
  return { answer: fields.answer, addition: values };
}

export function validAddition(part: AppPart, values: AppValues): boolean {
  const ids = Object.keys(values);
  if (ids.length === 0 || ids.some((id) => !part.fields.some((field) => field.id === id))) {
    return false;
  }
  return part.fields.every((field) => {
    const value = values[field.id];
    if (value === undefined) return !field.required;
    if (field.type === "text") {
      return (
        typeof value === "string" &&
        value === value.replace(/^[\s﻿]+|[\s﻿]+$/gu, "") &&
        value !== "" &&
        value.length <= 2000 &&
        !value.includes("\0")
      );
    }
    if (field.type === "number") return typeof value === "number" && Math.abs(value) <= 1e12;
    if (field.type === "date") return typeof value === "string" && validDate(value);
    return false;
  });
}

export function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days;
}
