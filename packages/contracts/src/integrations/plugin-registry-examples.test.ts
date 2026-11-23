import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RegistryPluginManifestSchema } from "./plugin-registry.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("record app example", () => {
  const example = JSON.parse(read("../../../../examples/plugins/kcal-diary/plugin.json"));

  it("is a registry manifest exactly as written", () => {
    expect(RegistryPluginManifestSchema.parse(example)).toEqual(example);
  });

  it.each([
    [` ${"x".repeat(118)} `, true],
    [` ${"x".repeat(119)} `, false],
    ["Meal‮", false],
    ["Me\0al", false],
    [" 　 ", false],
  ])("accepts the label %j: %s, as the native validator does", (label, accepted) => {
    const edited = structuredClone(example);
    edited.parts[0].fields[1].label = label;
    expect(RegistryPluginManifestSchema.safeParse(edited).success).toBe(accepted);
  });

  it("is the manifest the deployment bundles", () => {
    const migration = read(
      "../../../db/prisma/migrations/20261230150300_bundled_kcal_diary/migration.sql",
    );
    const bundled = migration.match(/'(\{[\s\S]*\})'::jsonb/)?.[1];
    expect(bundled).toBeDefined();
    expect(JSON.parse(bundled ?? "")).toEqual(example);
  });
});
