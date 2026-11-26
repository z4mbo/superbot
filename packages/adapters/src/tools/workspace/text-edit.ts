/**
 * Pure text edits for edit_file: an exact string replacement or a strict unified diff. Both keep
 * the file's line endings, and its trailing newline unless the edit itself changes it.
 */

export type TextEditResult = { text: string; count: number } | { error: string };

/** The line ending a file mostly uses; a file with no line break reads as LF. */
export function lineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** Text the model wrote with LF, in the file's own line ending. */
function inFileEndings(value: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? value : value.replace(/\r?\n/g, "\r\n");
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

/**
 * Replace `oldString` with `newString`. Without `replaceAll` the old string must occur exactly
 * once. In a CRLF file, text the model wrote with LF line breaks matches and is written as CRLF.
 */
export function replaceInText(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): TextEditResult {
  if (!oldString) return { error: "old_string is empty" };
  if (oldString === newString) return { error: "old_string and new_string are the same" };
  const eol = lineEnding(text);
  const search =
    eol === "\r\n" && !text.includes(oldString) ? inFileEndings(oldString, eol) : oldString;
  const replacement = eol === "\r\n" ? inFileEndings(newString, eol) : newString;
  const count = countOccurrences(text, search);
  if (count === 0) {
    return { error: "old_string was not found in the file; read the file and copy it exactly" };
  }
  if (count > 1 && !replaceAll) {
    return {
      error: `old_string matches ${count} places; include more surrounding text so it matches once, or set replace_all`,
    };
  }
  return { text: text.split(search).join(replacement), count };
}

type HunkLine = { kind: " " | "-" | "+"; text: string };
type Hunk = { header: string; oldStart: number; oldCount: number; lines: HunkLine[] };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ONE_FILE = "the patch changes more than one file; send one file per call";

/** Hunks of a unified diff for one file; lines between hunks (file headers) are skipped. */
function parsePatch(
  patch: string,
): { hunks: Hunk[]; oldNoNewline: boolean; newNoNewline: boolean } | { error: string } {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  // Lines the open hunk still needs from each side, as its header counts them.
  let oldLeft = 0;
  let newLeft = 0;
  let oldNoNewline = false;
  let newNoNewline = false;
  let files = 0;
  for (const line of lines) {
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line before it.
      const previous = hunks.at(-1)?.lines.at(-1);
      if (previous?.kind !== "+") oldNoNewline = true;
      if (previous?.kind !== "-") newNoNewline = true;
      continue;
    }
    if (current && (oldLeft > 0 || newLeft > 0)) {
      // An empty line is an empty context line some tools write without its space.
      const kind = line[0] ?? " ";
      if (kind !== " " && kind !== "-" && kind !== "+") {
        return {
          error: `hunk ${hunks.length} (${current.header}) ends early: each of its lines must start with a space, - or +`,
        };
      }
      current.lines.push({ kind, text: line.slice(1) });
      if (kind !== "+") oldLeft -= 1;
      if (kind !== "-") newLeft -= 1;
      if (oldLeft < 0 || newLeft < 0) {
        return {
          error: `hunk ${hunks.length} (${current.header}) has more lines than its header counts`,
        };
      }
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        header: header[0],
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      };
      oldLeft = current.oldCount;
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunks.push(current);
      continue;
    }
    if (line.startsWith("--- ") && ++files > 1) return { error: ONE_FILE };
  }
  if (!current) return { error: "the patch has no hunks (lines starting with @@)" };
  if (oldLeft > 0 || newLeft > 0) {
    return {
      error: `hunk ${hunks.length} (${current.header}) has fewer lines than its header counts`,
    };
  }
  return { hunks, oldNoNewline, newNoNewline };
}

/** The file's lines without their endings, and whether its last line ends with one. */
function splitLines(text: string, eol: "\r\n" | "\n") {
  const endsWithNewline = text.endsWith("\n");
  if (!endsWithNewline && text === "") return { lines: [] as string[], endsWithNewline };
  const body = endsWithNewline ? text.slice(0, text.endsWith(eol) ? -eol.length : -1) : text;
  return { lines: body.split(eol), endsWithNewline };
}

/**
 * Apply a unified diff strictly: every context and removed line must match the file where its
 * hunk says it starts. Nothing is applied when any hunk fails.
 */
export function applyUnifiedPatch(text: string, patch: string): TextEditResult {
  const parsed = parsePatch(patch);
  if ("error" in parsed) return parsed;
  const eol = lineEnding(text);
  const { lines, endsWithNewline } = splitLines(text, eol);
  const output: string[] = [];
  let cursor = 0;
  for (const [index, hunk] of parsed.hunks.entries()) {
    const expected = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    // A hunk that only adds lines goes after line oldStart; any other starts at it.
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const name = `hunk ${index + 1} (${hunk.header})`;
    if (start < cursor) return { error: `${name} overlaps the hunk before it` };
    const mismatch = expected.findIndex((line, offset) => lines[start + offset] !== line);
    if (start > lines.length || mismatch !== -1) {
      return {
        error: `${name} does not match the file at line ${start + Math.max(mismatch, 0) + 1}; read the file and make the patch from its current text`,
      };
    }
    output.push(...lines.slice(cursor, start));
    for (const line of hunk.lines) if (line.kind !== "-") output.push(line.text);
    cursor = start + expected.length;
  }
  output.push(...lines.slice(cursor));
  // The file keeps its trailing newline unless the patch marks a side as having none; text
  // patched into an empty file ends with one, as diff tools write it.
  const trailing = parsed.newNoNewline
    ? false
    : parsed.oldNoNewline || text === ""
      ? true
      : endsWithNewline;
  const joined = output.join(eol);
  return {
    text: output.length && trailing ? `${joined}${eol}` : joined,
    count: parsed.hunks.length,
  };
}
