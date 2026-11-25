import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTemporarySettings } from "../settings/settings.test-support.js";
import { forgetToken, readTokens, saveToken } from "./sessions-file.js";

const temporarySettings = useTemporarySettings();

describe("sessions file", () => {
  it("keeps one private token per server and goes once empty", async () => {
    const { directory } = await temporarySettings();
    const file = path.join(directory, "sessions.json");
    await saveToken(file, "https://one.example.test/", "one.signature");
    await saveToken(file, "https://two.example.test/", "two.signature");
    await saveToken(file, "https://one.example.test/", "one.renewed");
    expect(Object.fromEntries(await readTokens(file))).toEqual({
      "https://one.example.test/": "one.renewed",
      "https://two.example.test/": "two.signature",
    });
    expect(await readFile(file, "utf8")).toBe(
      '{"https://one.example.test/":"one.renewed","https://two.example.test/":"two.signature"}',
    );
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await forgetToken(file, "https://one.example.test/");
    expect((await readTokens(file)).has("https://one.example.test/")).toBe(false);
    await forgetToken(file, "https://two.example.test/");
    await expect(stat(file)).rejects.toThrow();
    await forgetToken(file, "https://two.example.test/");
    expect((await readTokens(file)).size).toBe(0);
  });

  it("treats an unreadable file as an error, not an empty store", async () => {
    const { directory } = await temporarySettings();
    const file = path.join(directory, "sessions.json");
    await saveToken(file, "https://one.example.test/", "one.signature");
    for (const content of ["not json", '["list"]', '{"https://one.example.test/":1}']) {
      await writeFile(file, content);
      await expect(readTokens(file)).rejects.toThrow();
      await expect(saveToken(file, "https://one.example.test/", "token")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(content);
    }
  });
});
