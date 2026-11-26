/** Long enough for a curated changelog section plus the merged pull requests GitHub appends. */
export const MAX_RELEASE_NOTES_LENGTH = 6_000;
// Bounds the work on a hostile feed before the text is cut to its shown length.
const MAX_SOURCE_LENGTH = 200_000;

const LINE_BREAK = /<br\s*\/?>|<\/(?:p|div|h[1-6]|ul|ol|pre|blockquote|tr|table)\s*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const TAG = /<[^>]*>/g;
const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
// Control characters other than tab and newline, which only garble a text view.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function decodeEntity(entity: string, body: string) {
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : "";
  }
  return NAMED[body.toLowerCase()] ?? entity;
}

/**
 * The release host's notes (HTML from the GitHub release feed, or plain text from the update
 * file) as plain text. Tags are dropped before entities are decoded, so escaped markup stays
 * visible text, and the renderer only ever shows the result as text.
 */
export function releaseNotesText(source: string): string | null {
  return bounded(plainText(source));
}

/** Drops tags until none is left, so removing one can never splice another together. */
function withoutTags(text: string) {
  let previous: string;
  let next = text;
  do {
    previous = next;
    next = previous.replace(TAG, "");
  } while (next !== previous);
  return next;
}

function plainText(source: string) {
  const lines = source
    .slice(0, MAX_SOURCE_LENGTH)
    .replace(/\r\n?/g, "\n")
    .replace(LIST_ITEM, "\n• ")
    .replace(LINE_BREAK, "\n");
  return withoutTags(lines)
    .replace(ENTITY, decodeEntity)
    .replace(CONTROL, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bounded(text: string) {
  if (text === "") return null;
  if (text.length <= MAX_RELEASE_NOTES_LENGTH) return text;
  // Cut on a code point, never inside a surrogate pair.
  let cut = text.slice(0, MAX_RELEASE_NOTES_LENGTH);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  // End on a whole word when one ends near the limit.
  const space = cut.search(/\s\S*$/);
  if (space > MAX_RELEASE_NOTES_LENGTH - 200) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** Reads `releaseNotes` from an updater payload: one release's notes, or several versions'. */
export function releaseNotesFrom(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("releaseNotes" in payload)) return null;
  const notes = payload.releaseNotes;
  if (typeof notes === "string") return releaseNotesText(notes);
  if (!Array.isArray(notes)) return null;
  const sections = notes.slice(0, 20).flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const note = "note" in entry && typeof entry.note === "string" ? entry.note : "";
    const version = "version" in entry && typeof entry.version === "string" ? entry.version : "";
    const body = plainText(note);
    return body === "" ? [] : [version === "" ? body : `${version}\n${body}`];
  });
  return bounded(sections.join("\n\n"));
}
