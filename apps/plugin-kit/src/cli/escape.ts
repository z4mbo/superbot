/**
 * Error text escaped as the plugin tool has always printed it, so a server's message can never
 * move the cursor or rewrite the terminal: backslashes, quotes, line breaks and every character
 * that is not printable become visible escapes such as `\n` and `\u{1b}`.
 */
export function escapeForTerminal(text: string): string {
  let escaped = "";
  let first = true;
  for (const character of text) {
    escaped += escapeCharacter(character, { singleQuote: true, combining: first });
    first = false;
  }
  return escaped;
}

/** A value quoted with its special characters escaped, as `{:?}` shows a string. */
export function quoted(text: string): string {
  let escaped = "";
  for (const character of text) {
    escaped += escapeCharacter(character, { singleQuote: false, combining: true });
  }
  return `"${escaped}"`;
}

/** Controls, format characters, surrogates, private use, unassigned and separators but the space. */
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const COMBINING = /^\p{Grapheme_Extend}$/u;

function escapeCharacter(
  character: string,
  { singleQuote, combining }: { singleQuote: boolean; combining: boolean },
): string {
  switch (character) {
    case "\0":
      return "\\0";
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    case "\n":
      return "\\n";
    case "\\":
      return "\\\\";
    case '"':
      return '\\"';
    case "'":
      return singleQuote ? "\\'" : character;
    case " ":
      return character;
  }
  // A combining mark escapes only where it would attach to the text before it.
  if (NOT_PRINTABLE.test(character) || (combining && COMBINING.test(character))) {
    return `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
  }
  return character;
}
