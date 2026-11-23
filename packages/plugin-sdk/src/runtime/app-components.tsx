import type { AppActionInput } from "@rakazo/contracts";
import type { KeyboardEvent } from "react";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { ActionResult } from "./app-store.js";
import { actionsAvailable, getState, runAction, subscribe, surface } from "./app-store.js";

/** The app's stored state, kept current as people and bots run its actions. Read-only. */
export function useAppState(): Record<string, unknown> {
  return useSyncExternalStore(subscribe, getState, getState);
}

/**
 * A function that runs the named action with an input and resolves whether it ran. Call it from
 * a click or a key, never on its own: the host refuses actions nobody asked for.
 */
export function useAction(
  name: string,
): (input?: Record<string, unknown>) => Promise<ActionResult> {
  return useCallback((input?: Record<string, unknown>) => runAction(name, input), [name]);
}

function useRun(action: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    (input?: Record<string, unknown>) => {
      setPending(true);
      setError(null);
      return runAction(action, input).then((result) => {
        setPending(false);
        if (!result.ok) setError(result.error);
        return result;
      });
    },
    [action],
  );
  return { run, pending, error };
}

function ActionError({ error }: { error: string | null }) {
  return error ? (
    <p className="rk-row-detail" role="alert">
      {error}
    </p>
  ) : null;
}

/** A button that runs one action with a fixed input. */
export function ActionButton({
  action,
  input,
  label,
  variant = "quiet",
}: {
  action?: string;
  input?: Record<string, unknown>;
  label?: string;
  variant?: "quiet" | "primary";
}) {
  const { run, pending, error } = useRun(String(action ?? ""));
  if (!label || !action) return null;
  return (
    <span>
      <button
        type="button"
        className="rk-button"
        data-variant={variant === "primary" ? "primary" : undefined}
        disabled={pending || !actionsAvailable()}
        onClick={() => void run(input)}
      >
        {label}
      </button>
      <ActionError error={error} />
    </span>
  );
}

type Value = string | boolean;

function initialValues(fields: [string, AppActionInput][]): Record<string, Value> {
  return Object.fromEntries(
    fields.map(([name, field]) => [name, field.type === "boolean" ? false : ""]),
  );
}

function inputFrom(fields: [string, AppActionInput][], values: Record<string, Value>) {
  const input: Record<string, unknown> = {};
  for (const [name, field] of fields) {
    const value = values[name];
    if (field.type === "boolean") input[name] = value === true;
    else if (value === "" || value === undefined) continue;
    else input[name] = field.type === "number" ? Number(value) : value;
  }
  return input;
}

function label(name: string, field: AppActionInput) {
  return field.description ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

/**
 * A form for an action's declared inputs and a button that runs it. `fixed` sets inputs the
 * form does not show; after a run the form clears.
 */
export function ActionForm({
  action,
  label: buttonLabel,
  fixed,
}: {
  action?: string;
  label?: string;
  fixed?: Record<string, unknown>;
}) {
  const declared = surface().actions.find((entry) => entry.name === action);
  const fields = Object.entries(declared?.input ?? {}).filter(
    ([name]) => !fixed || !Object.hasOwn(fixed, name),
  );
  const [values, setValues] = useState(() => initialValues(fields));
  const { run, pending, error } = useRun(String(action ?? ""));
  if (!declared || !buttonLabel) return null;
  const set = (name: string, value: Value) =>
    setValues((current) => ({ ...current, [name]: value }));
  // The viewer's sandbox blocks form submission, so a click or Enter runs the action directly.
  const submit = () => {
    void run({ ...inputFrom(fields, values), ...fixed }).then((result) => {
      if (result.ok) setValues(initialValues(fields));
    });
  };
  const available = actionsAvailable();
  return (
    <div className="rk-actions" role="group" aria-label={buttonLabel}>
      {fields.map(([name, field]) =>
        field.type === "boolean" ? (
          <label key={name} className="rk-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={values[name] === true}
              aria-checked={values[name] === true}
              disabled={!available}
              onChange={(event) => set(name, event.target.checked)}
            />
            <span className="rk-toggle-track" aria-hidden="true">
              <span className="rk-toggle-thumb" />
            </span>
            <span className="rk-toggle-label">{label(name, field)}</span>
          </label>
        ) : field.type === "string" && field.enum ? (
          <label key={name} className="rk-field">
            <span className="rk-field-label">{label(name, field)}</span>
            <select
              className="rk-input"
              value={String(values[name] ?? "")}
              disabled={!available}
              onChange={(event) => set(name, event.target.value)}
            >
              <option value="" />
              {field.enum.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={name} className="rk-field">
            <span className="rk-field-label">{label(name, field)}</span>
            <input
              className="rk-input"
              type={field.type === "number" ? "number" : "text"}
              required={field.required === true}
              maxLength={field.type === "string" ? field.maxLength : undefined}
              value={String(values[name] ?? "")}
              disabled={!available}
              onChange={(event) => set(name, event.target.value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter" && !pending) submit();
              }}
            />
          </label>
        ),
      )}
      <button
        type="button"
        className="rk-button"
        data-variant="primary"
        disabled={pending || !available}
        onClick={submit}
      >
        {buttonLabel}
      </button>
      <ActionError error={error} />
    </div>
  );
}
