/** Unicode control characters (C0, DEL and C1) except the line feed and tab a transcript keeps. */
const CONTROL = /(?![\n\t])\p{Cc}/gu;

/**
 * Text from the server as it may reach the terminal: control characters are dropped so a message
 * cannot move the cursor, change colours or write to the clipboard.
 */
export function terminalText(value: string): string {
  return value.replace(CONTROL, "");
}

/**
 * A string quoted as the Rust CLI printed names in its messages (`{:?}`): in double quotes, with
 * quotes, backslashes and control characters escaped.
 */
export function quoted(value: string): string {
  return `"${escapeDebug(value, false)}"`;
}

/**
 * A string escaped as the Rust CLI printed app data (`escape_debug`), which escapes both kinds of
 * quote.
 */
export function escapeDebug(value: string, singleQuotes = true): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\t":
        escaped += "\\t";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "'":
        escaped += singleQuotes ? "\\'" : "'";
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        escaped +=
          code < 0x20 || (code >= 0x7f && code <= 0x9f) ? `\\u{${code.toString(16)}}` : char;
      }
    }
  }
  return escaped;
}

/** Pretty JSON as the command prints it: two-space indentation, in the order the keys were set. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** The lines of `text` as Rust's `str::lines` gives them: no empty last line, no `\r` endings. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((row) => row.replace(/\r$/, ""));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
