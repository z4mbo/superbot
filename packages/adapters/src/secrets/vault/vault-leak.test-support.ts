import { cardRedactionForms, passwordRedactionForms } from "./vault-redaction.js";

/**
 * Fixture secrets a test put in the vault, a Secure form or a page, which nothing a model reads or
 * a transcript keeps may hold. Use fixture values only, such as the test card 4242 4242 4242 4242.
 */
export type VaultSecretFixture = {
  /** Card numbers, found as given, as digits, and spaced or dashed as cards print. */
  cardNumbers?: readonly string[];
  /**
   * Security codes, found as a number of their own: three or four digits inside a longer number,
   * such as an id or a total, are not a code.
   */
  cvcs?: readonly string[];
  /** Passwords, one-time codes and keys, found raw and percent-, form- or base64-encoded. */
  passwords?: readonly string[];
};

type Form = { label: string; matches: (text: string) => boolean };

function forms(fixture: VaultSecretFixture): Form[] {
  const substring = (label: string, form: string): Form => ({
    label,
    matches: (text) => text.includes(form),
  });
  return [
    ...(fixture.cardNumbers ?? []).flatMap((number) =>
      cardRedactionForms(number).map((form) => substring(`card number "${form}"`, form)),
    ),
    ...(fixture.cvcs ?? []).map((cvc) => {
      const token = new RegExp(`(?<![0-9])${cvc.replace(/\D/g, "")}(?![0-9])`);
      return { label: `security code "${cvc}"`, matches: (text: string) => token.test(text) };
    }),
    ...(fixture.passwords ?? []).flatMap((password) =>
      passwordRedactionForms(password).map((form) => substring(`password "${form}"`, form)),
    ),
  ];
}

/** Every string inside a value, as its own text and as JSON escapes it, keys included. */
function texts(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [String(value)];
  if (value instanceof Uint8Array) return [new TextDecoder().decode(value)];
  if (value instanceof Date) return [value.toISOString()];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, entry]) => [key, ...texts(entry, seen)]);
}

/**
 * Where each fixture secret shows up in `places`, a map of what a run or transcript holds (the
 * model's request, each tool result, the persisted message parts, events, logs) by a name for it.
 * Empty when nothing leaked.
 */
export function findVaultSecretLeaks(
  places: Record<string, unknown>,
  fixture: VaultSecretFixture,
): string[] {
  const all = forms(fixture);
  return Object.entries(places).flatMap(([place, value]) => {
    const found = texts(value);
    // The serialized whole too, so a value split across keys in one object is still found.
    let serialized = "";
    try {
      serialized = JSON.stringify(value) ?? "";
    } catch {}
    return all
      .filter((form) => found.some((text) => form.matches(text)) || form.matches(serialized))
      .map((form) => `${form.label} in ${place}`);
  });
}

/** Throws, listing every leak, unless no fixture secret is anywhere in `places`. */
export function expectNoVaultSecrets(
  places: Record<string, unknown>,
  fixture: VaultSecretFixture,
): void {
  const leaks = findVaultSecretLeaks(places, fixture);
  if (leaks.length) throw new Error(`Vault secrets leaked:\n${leaks.join("\n")}`);
}
