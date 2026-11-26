import type {
  AppAction,
  AppActionEffect,
  AppActionInput,
  AppManifest,
  appStateSchema,
} from "@rakazo/contracts";
import { APP_STATE_MAX_BYTES } from "@rakazo/contracts";
import type * as z from "zod";
import { findAction } from "../manifest/manifest.js";

/** An app's state: a JSON object the host stores and only declared actions change. */
export type AppState = z.infer<typeof appStateSchema>;

export type ActionOutcome = { ok: true; state: AppState } | { ok: false; error: string };
export type InputParse =
  | { ok: true; input: Record<string, string | number | boolean> }
  | { ok: false; error: string };

const DEFAULT_STRING_MAX = 4000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fieldProblem(name: string, field: AppActionInput, value: unknown): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return `${name} must be text.`;
    if (value.length > (field.maxLength ?? DEFAULT_STRING_MAX))
      return `${name} must be at most ${field.maxLength ?? DEFAULT_STRING_MAX} characters.`;
    if (field.enum && !field.enum.includes(value))
      return `${name} must be one of: ${field.enum.join(", ")}.`;
    return undefined;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number.`;
    if (field.integer && !Number.isInteger(value)) return `${name} must be a whole number.`;
    if (field.min !== undefined && value < field.min)
      return `${name} must be at least ${field.min}.`;
    if (field.max !== undefined && value > field.max)
      return `${name} must be at most ${field.max}.`;
    return undefined;
  }
  return typeof value === "boolean" ? undefined : `${name} must be true or false.`;
}

/**
 * Values checked against the fields they are for: only declared fields, each of its type, every
 * required one present unless `partial` (a change to a record that already has them). An
 * action's input, a card's input and a stored record are all checked here.
 */
export function parseFields(
  fields: Record<string, AppActionInput>,
  value: unknown,
  options: { owner: string; takes?: string; partial?: boolean },
): InputParse {
  const given = value === undefined || value === null ? {} : value;
  if (!isPlainObject(given)) return { ok: false, error: "The input must be an object." };
  const input: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(fields, key))
      return {
        ok: false,
        error: `${options.owner} ${options.takes ?? "takes no input"} named ${key}.`,
      };
  }
  for (const [name, field] of Object.entries(fields)) {
    const present = Object.hasOwn(given, name) && given[name] !== undefined && given[name] !== null;
    if (!present) {
      if (field.required && !options.partial) return { ok: false, error: `${name} is required.` };
      continue;
    }
    const problem = fieldProblem(name, field, given[name]);
    if (problem) return { ok: false, error: problem };
    input[name] = given[name] as string | number | boolean;
  }
  return { ok: true, input };
}

/**
 * The input an action was sent, checked against what it declares. A person's control, a bot's
 * tool call and a server function's caller all go through here.
 */
export function parseActionInput(action: AppAction, value: unknown): InputParse {
  return parseFields(action.input, value, { owner: action.name });
}

class EffectError extends Error {}

/** The object holding the last key of `path`, made on the way when `create` is set. */
function container(state: AppState, path: string, create: boolean) {
  const keys = path.split(".");
  const last = keys.pop()!;
  let at: Record<string, unknown> = state;
  for (const key of keys) {
    const next = Object.hasOwn(at, key) ? at[key] : undefined;
    if (next === undefined && create) {
      const made: Record<string, unknown> = {};
      at[key] = made;
      at = made;
    } else if (isPlainObject(next)) at = next;
    else throw new EffectError(`${path} does not lead to a value in the app's state.`);
  }
  return { at, key: last };
}

function read(state: AppState, path: string): unknown {
  const { at, key } = container(state, path, true);
  return Object.hasOwn(at, key) ? at[key] : undefined;
}

function write(state: AppState, path: string, value: unknown) {
  const { at, key } = container(state, path, true);
  at[key] = value;
}

function list(state: AppState, path: string): unknown[] {
  const value = read(state, path);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new EffectError(`${path} is not a list.`);
  return value;
}

function matches(item: unknown, key: string, value: unknown): item is Record<string, unknown> {
  return isPlainObject(item) && Object.hasOwn(item, key) && item[key] === value;
}

type Input = Record<string, string | number | boolean>;

/** The value a step takes: one field, a fixed value, or the whole input; undefined skips it. */
function sourceValue(input: Input, from: string | undefined, fixed?: unknown): unknown {
  if (from !== undefined) return Object.hasOwn(input, from) ? input[from] : undefined;
  if (fixed !== undefined) return structuredClone(fixed);
  return { ...input };
}

function applyEffect(state: AppState, effect: AppActionEffect, input: Input, newId: () => string) {
  switch (effect.op) {
    case "set": {
      const value = sourceValue(input, effect.from, effect.value);
      if (value !== undefined) write(state, effect.path, value);
      return;
    }
    case "append": {
      const value = sourceValue(input, effect.from);
      if (value === undefined) return;
      const item = effect.assignId && isPlainObject(value) ? { id: newId(), ...value } : value;
      const next = [...list(state, effect.path), item];
      write(state, effect.path, effect.max ? next.slice(-effect.max) : next);
      return;
    }
    case "update": {
      const target = input[effect.match];
      const items = list(state, effect.path);
      if (!items.some((item) => matches(item, effect.key, target)))
        throw new EffectError(`No item in ${effect.path} has that ${effect.key}.`);
      const { [effect.match]: _match, ...changes } = input;
      write(
        state,
        effect.path,
        items.map((item) => (matches(item, effect.key, target) ? { ...item, ...changes } : item)),
      );
      return;
    }
    case "remove": {
      // Removing what is already gone changes nothing: a retried request lands the same way.
      const target = input[effect.match];
      write(
        state,
        effect.path,
        list(state, effect.path).filter((item) => !matches(item, effect.key, target)),
      );
      return;
    }
    case "increment": {
      // An input left out falls back to `by`, then to 1.
      const given = effect.from !== undefined ? input[effect.from] : undefined;
      const by = given ?? effect.by ?? 1;
      if (typeof by !== "number") throw new EffectError(`${effect.from} must be a number.`);
      const current = read(state, effect.path) ?? 0;
      if (typeof current !== "number") throw new EffectError(`${effect.path} is not a number.`);
      const next = current + by;
      if (!Number.isFinite(next)) throw new EffectError(`${effect.path} would not be a number.`);
      write(state, effect.path, next);
      return;
    }
    case "toggle": {
      if (effect.field === undefined) {
        const current = read(state, effect.path) ?? false;
        if (typeof current !== "boolean") throw new EffectError(`${effect.path} is not on or off.`);
        write(state, effect.path, !current);
        return;
      }
      const field = effect.field;
      const target = input[effect.match];
      const items = list(state, effect.path);
      if (!items.some((item) => matches(item, effect.key, target)))
        throw new EffectError(`No item in ${effect.path} has that ${effect.key}.`);
      write(
        state,
        effect.path,
        items.map((item) =>
          matches(item, effect.key, target) ? { ...item, [field]: item[field] !== true } : item,
        ),
      );
      return;
    }
  }
}

export function appStateBytes(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

/**
 * Runs one declared action on a copy of the state and returns the new state, or why it could
 * not run. It never changes the state it was given. The same function runs for a person and a
 * bot, so both get the same result for the same input.
 */
export function applyAppAction(
  manifest: Pick<AppManifest, "actions" | "permissions">,
  state: AppState,
  name: unknown,
  value: unknown,
  options: { newId: () => string },
): ActionOutcome {
  if (!manifest.permissions.includes("state"))
    return { ok: false, error: "This app keeps no state." };
  const action = findAction(manifest, name);
  if (!action) return { ok: false, error: `This app has no action named ${String(name)}.` };
  if (!action.effects)
    return {
      ok: false,
      error: `${action.name} runs a server function, which only an installed app has.`,
    };
  const effects = action.effects;
  const parsed = parseActionInput(action, value);
  if (!parsed.ok) return parsed;
  // A fresh copy through JSON: what the effects build shares nothing with the stored state.
  const next = JSON.parse(JSON.stringify(state)) as AppState;
  try {
    for (const effect of effects) applyEffect(next, effect, parsed.input, options.newId);
  } catch (error) {
    if (error instanceof EffectError) return { ok: false, error: error.message };
    throw error;
  }
  if (appStateBytes(next) > APP_STATE_MAX_BYTES)
    return { ok: false, error: `The app's state would be over ${APP_STATE_MAX_BYTES} bytes.` };
  return { ok: true, state: next };
}

/** Problems with the effects an action declares that its inputs cannot satisfy. */
export function actionEffectProblems(action: AppAction): string[] {
  const problems: string[] = [];
  const named = (field: string | undefined, label: string, type?: AppActionInput["type"]) => {
    if (field === undefined) return;
    const input = Object.hasOwn(action.input, field) ? action.input[field] : undefined;
    if (!input) problems.push(`${action.name}: ${label} names ${field}, which is not an input.`);
    else if (type && input.type !== type)
      problems.push(`${action.name}: ${label} ${field} must be a ${type} input.`);
  };
  for (const effect of action.effects ?? []) {
    if (effect.op === "set" || effect.op === "append") named(effect.from, `${effect.op} from`);
    if (effect.op === "increment") named(effect.from, "increment from", "number");
    if (effect.op === "update" || effect.op === "remove" || effect.op === "toggle") {
      if (effect.op !== "toggle" || effect.field !== undefined)
        named(effect.match, `${effect.op} match`);
    }
  }
  return problems;
}
