import { describe, expect, it } from "vitest";
import { escapeForTerminal, quoted } from "./escape.js";
import { jaro, similar } from "./suggestions.js";

describe("escapeForTerminal", () => {
  it("leaves printable text alone", () => {
    expect(escapeForTerminal("Created plugin.json — “ok” 😀 ü")).toBe(
      "Created plugin.json — “ok” 😀 ü",
    );
  });

  it("escapes quotes, backslashes, line breaks and control characters", () => {
    expect(escapeForTerminal('Can\'t "x" \\ a\tb\r\n\0\u001b[2J\u007f')).toBe(
      'Can\\\'t \\"x\\" \\\\ a\\tb\\r\\n\\0\\u{1b}[2J\\u{7f}',
    );
  });

  it("escapes invisible format characters and unusual spaces, but not the space", () => {
    expect(escapeForTerminal("a\u202eb\u00a0c\u200bd\u2028e f")).toBe(
      "a\\u{202e}b\\u{a0}c\\u{200b}d\\u{2028}e f",
    );
  });

  it("escapes a combining mark only where it would join the text before it", () => {
    expect(escapeForTerminal("\u0301e\u0301")).toBe("\\u{301}e\u0301");
  });
});

describe("quoted", () => {
  it("quotes and escapes like a debug string, keeping single quotes", () => {
    expect(quoted('Team\'s "x"\n')).toBe('"Team\'s \\"x\\"\\n"');
    expect(quoted("e\u0301")).toBe('"e\\u{301}"');
  });
});

describe("suggestions", () => {
  it("scores by Jaro similarity", () => {
    expect(jaro("", "")).toBe(1);
    expect(jaro("abc", "")).toBe(0);
    expect(jaro("martha", "marhta")).toBeCloseTo(0.944, 3);
    expect(jaro("mien", "mine")).toBeGreaterThan(0.7);
  });

  it("lists close candidates with the closest last", () => {
    expect(similar("instal", ["init", "list", "uninstall", "install", "review"])).toEqual([
      "init",
      "list",
      "uninstall",
      "install",
    ]);
    expect(similar("zzz", ["init"])).toEqual([]);
  });
});
