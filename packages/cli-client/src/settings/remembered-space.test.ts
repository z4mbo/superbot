import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "../client/client.js";
import { rememberedSpace, rememberSpace } from "./remembered-space.js";
import { useTemporarySettings } from "./settings.test-support.js";

const temporarySettings = useTemporarySettings();

describe("remembered Spaces", () => {
  it("returns each account on each server to its own Space", async () => {
    const { directory, settings } = await temporarySettings();
    const first = new Client("https://first.example.test");
    const second = new Client("https://second.example.test");
    expect(await rememberedSpace(first, "ada", settings)).toBeUndefined();
    await rememberSpace(first, "ada", "team", settings);
    await rememberSpace(first, "grace", "lab", settings);
    await rememberSpace(second, "ada", "home", settings);
    await rememberSpace(first, "ada", "research", settings);
    expect(await rememberedSpace(first, "ada", settings)).toBe("research");
    expect(await rememberedSpace(first, "grace", settings)).toBe("lab");
    expect(await rememberedSpace(second, "ada", settings)).toBe("home");
    const file = path.join(directory, "spaces.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "https://first.example.test/ ada": "research",
      "https://first.example.test/ grace": "lab",
      "https://second.example.test/ ada": "home",
    });
    await writeFile(file, "not json");
    expect(await rememberedSpace(first, "ada", settings)).toBeUndefined();
  });
});
