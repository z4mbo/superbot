import type { RegistryAppField, RegistryAppPart, RegistryAppRecord } from "./registry";

export type AppValues = RegistryAppRecord["values"];
export type FieldProblem = "required" | "number" | "range" | "date" | "length";

const MAX_TEXT = 2000;
const MAX_NUMBER = 1e12;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the viewer's own time zone, as the registry's date values are written. */
export function localIsoDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return localIsoDate(new Date(year!, month! - 1, day! + days));
}

/** A date value as a calendar day, never shifted by the viewer's time zone. */
export function isoDateAsLocal(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

/** The field the registry filters dates by: the first date field in manifest order. */
export function dateField(part: RegistryAppPart): RegistryAppField | undefined {
  return part.fields.find((field) => field.type === "date");
}

export function summaryField(part: RegistryAppPart): RegistryAppField | undefined {
  return part.summaryField
    ? part.fields.find((field) => field.id === part.summaryField)
    : undefined;
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return localIsoDate(isoDateAsLocal(value)) === value;
}

/** What a member typed, as the values the registry accepts, or what to fix in each field. */
export function readAppForm(
  part: RegistryAppPart,
  form: Readonly<Record<string, string>>,
): { ok: true; values: AppValues } | { ok: false; problems: Record<string, FieldProblem> } {
  const values: AppValues = {};
  const problems: Record<string, FieldProblem> = {};
  for (const field of part.fields) {
    const raw = (form[field.id] ?? "").trim();
    if (!raw) {
      if (field.required) problems[field.id] = "required";
      continue;
    }
    if (field.type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) problems[field.id] = "number";
      else if (Math.abs(number) > MAX_NUMBER) problems[field.id] = "range";
      else values[field.id] = number;
    } else if (field.type === "date") {
      if (isRealDate(raw)) values[field.id] = raw;
      else problems[field.id] = "date";
    } else if (raw.length > MAX_TEXT) problems[field.id] = "length";
    else values[field.id] = raw;
  }
  return Object.keys(problems).length ? { ok: false, problems } : { ok: true, values };
}
