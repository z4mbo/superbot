import { describe, expect, it } from "vitest";
import { applyUnifiedPatch, lineEnding, replaceInText } from "./text-edit.js";

describe("replaceInText", () => {
  it("replaces the one match", () => {
    expect(replaceInText("a = 1;\nb = 2;\n", "b = 2", "b = 3", false)).toEqual({
      text: "a = 1;\nb = 3;\n",
      count: 1,
    });
  });

  it("refuses a missing string", () => {
    expect(replaceInText("a\n", "zzz", "y", false)).toEqual({
      error: expect.stringContaining("not found"),
    });
  });

  it("refuses a string that matches more than once and says how many times", () => {
    expect(replaceInText("x x x\n", "x", "y", false)).toEqual({
      error: expect.stringContaining("matches 3 places"),
    });
  });

  it("replaces every match with replace_all", () => {
    expect(replaceInText("x x x\n", "x", "y", true)).toEqual({ text: "y y y\n", count: 3 });
  });

  it("refuses an empty or unchanged old string", () => {
    expect(replaceInText("a", "", "b", false)).toHaveProperty("error");
    expect(replaceInText("a", "a", "a", false)).toHaveProperty("error");
  });

  it("matches LF text in a CRLF file and writes CRLF", () => {
    const result = replaceInText("one\r\ntwo\r\nthree\r\n", "one\ntwo", "one\nTWO\nmore", false);
    expect(result).toEqual({ text: "one\r\nTWO\r\nmore\r\nthree\r\n", count: 1 });
  });

  it("keeps a missing trailing newline", () => {
    expect(replaceInText("last", "last", "final", false)).toEqual({ text: "final", count: 1 });
  });
});

describe("applyUnifiedPatch", () => {
  const file = ["one", "two", "three", "four", "five", "six", "seven", "eight", ""].join("\n");

  it("applies hunks with matching context", () => {
    const patch = [
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -6,3 +6,4 @@",
      " six",
      " seven",
      "+seven and a half",
      " eight",
    ].join("\n");
    expect(applyUnifiedPatch(file, patch)).toEqual({
      text: [
        "one",
        "TWO",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "seven and a half",
        "eight",
        "",
      ].join("\n"),
      count: 2,
    });
  });

  it("reports the hunk whose context does not match and changes nothing", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -4,2 +4,2 @@",
      " FOUR",
      "-five",
      "+5",
    ].join("\n");
    const result = applyUnifiedPatch(file, patch);
    expect(result).toEqual({ error: expect.stringContaining("hunk 2 (@@ -4,2 +4,2 @@)") });
    expect((result as { error: string }).error).toContain("line 4");
  });

  it("refuses a patch whose lines do not add up to its header", () => {
    expect(applyUnifiedPatch(file, "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n")).toEqual({
      error: expect.stringContaining("fewer lines"),
    });
  });

  it("refuses a patch for two files and a patch with no hunks", () => {
    const two = [
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "--- a/y",
      "+++ b/y",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
    ].join("\n");
    expect(applyUnifiedPatch(file, two)).toEqual({
      error: expect.stringContaining("more than one file"),
    });
    expect(applyUnifiedPatch(file, "just words")).toEqual({
      error: expect.stringContaining("no hunks"),
    });
  });

  it("treats a removed line that starts with dashes as part of its hunk", () => {
    const text = "-- comment\nkeep\n";
    expect(applyUnifiedPatch(text, "@@ -1,2 +1,1 @@\n--- comment\n keep\n")).toEqual({
      text: "keep\n",
      count: 1,
    });
  });

  it("keeps CRLF endings and the trailing newline", () => {
    const text = "one\r\ntwo\r\nthree\r\n";
    expect(applyUnifiedPatch(text, "@@ -2 +2 @@\n-two\n+TWO\n")).toEqual({
      text: "one\r\nTWO\r\nthree\r\n",
      count: 1,
    });
    expect(lineEnding(text)).toBe("\r\n");
  });

  it("follows no-newline markers on either side", () => {
    expect(
      applyUnifiedPatch("a\nb", "@@ -2 +2,2 @@\n-b\n\\ No newline at end of file\n+b\n+c\n"),
    ).toEqual({ text: "a\nb\nc\n", count: 1 });
    expect(
      applyUnifiedPatch("a\nb\n", "@@ -2 +2 @@\n-b\n+c\n\\ No newline at end of file\n"),
    ).toEqual({ text: "a\nc", count: 1 });
    expect(applyUnifiedPatch("a\nb", "@@ -1 +1 @@\n-a\n+A\n")).toEqual({ text: "A\nb", count: 1 });
  });

  it("adds lines to an empty file and after a given line", () => {
    expect(applyUnifiedPatch("", "@@ -0,0 +1,2 @@\n+first\n+second\n")).toEqual({
      text: "first\nsecond\n",
      count: 1,
    });
    expect(applyUnifiedPatch("a\nb\n", "@@ -1,0 +2 @@\n+between\n")).toEqual({
      text: "a\nbetween\nb\n",
      count: 1,
    });
  });

  it("refuses overlapping hunks", () => {
    const patch = "@@ -2 +2 @@\n-two\n+TWO\n@@ -2 +2 @@\n-two\n+2\n";
    expect(applyUnifiedPatch(file, patch)).toEqual({ error: expect.stringContaining("overlaps") });
  });
});
