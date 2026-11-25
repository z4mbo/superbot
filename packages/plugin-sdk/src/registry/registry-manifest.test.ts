import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegistryManifest } from "./registry-manifest.js";
import {
  normalizeRegistryManifest,
  RegistryManifestError,
  readRegistryManifest,
  registryManifestText,
} from "./registry-manifest.js";

const example = (path: string) =>
  readFileSync(new URL(`../../../../examples/plugins/${path}`, import.meta.url), "utf8");
const MCP_APP = example("marketplace-unit-converter/manifest.json");
const KCAL_DIARY = example("kcal-diary/plugin.json");

type Json = Record<string, unknown>;

const skill = (): Json => ({
  schemaVersion: 1,
  name: "Release notes",
  description: "Summarize the main points in the supplied text.",
  parts: [
    {
      kind: "skill",
      id: "summary",
      instructions: "Summarize the supplied text in three bullet points.",
    },
  ],
});
const app = (): Json => JSON.parse(MCP_APP);
const diary = (): Json => JSON.parse(KCAL_DIARY);

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (value: unknown) => readRegistryManifest(bytes(JSON.stringify(value)));

/** Replaces the value at a JSON pointer such as `/parts/0/id`, as serde's `pointer_mut` does. */
function edit(value: Json, pointer: string, replacement: unknown): Json {
  const keys = pointer.split("/").slice(1);
  const last = keys.pop() as string;
  let target: unknown = value;
  for (const key of keys) target = (target as Json)[key];
  if (!(last in (target as Json))) throw new Error(`No value at ${pointer}`);
  (target as Json)[last] = replacement;
  return value;
}

function failure(run: () => unknown): RegistryManifestError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryManifestError);
    return error as RegistryManifestError;
  }
  throw new Error("expected the manifest to be refused");
}

const fields = (manifest: RegistryManifest) => {
  const part = manifest.parts[0];
  if (part?.kind !== "app") throw new Error("the example is an app");
  return part;
};

describe("registry manifests", () => {
  it("round-trips the record app example byte for byte", () => {
    const manifest = normalizeRegistryManifest(readRegistryManifest(bytes(KCAL_DIARY)));
    expect(registryManifestText(manifest)).toBe(KCAL_DIARY);
    const part = fields(manifest);
    expect(part.id).toBe("meals");
    expect(part.summaryField).toBe("kcal");
    expect(part.fields.map(({ id, label, type, required }) => [id, label, type, required])).toEqual(
      [
        ["date", "Date", "date", true],
        ["meal", "Meal", "text", true],
        ["kcal", "Calories (kcal)", "number", true],
      ],
    );

    const untotalled = diary();
    delete ((untotalled.parts as Json[])[0] as Json).summaryField;
    const written = registryManifestText(normalizeRegistryManifest(read(untotalled)));
    expect(written).not.toContain("summaryField");
  });

  it.each([
    ["/parts/0/fields", {}],
    ["/parts/0/fields/0/type", "boolean"],
    ["/parts/0/fields/0/required", "yes"],
    ["/parts/0/fields/0/label", 3],
    ["/parts/0/summaryField", null],
    ["/parts/0/fields", Array.from({ length: 65 }, () => fields(read(diary())).fields[0])],
  ])("refuses app shapes a plugin cannot carry: %s", (pointer, value) => {
    expect(failure(() => read(edit(diary(), pointer, value))).unsupported).toBe(true);
  });

  it("names an extra or missing app field", () => {
    expect(failure(() => read(addField(diary(), "default", "today"))).path).toBe(
      "parts[0].fields[0].default",
    );
    const missing = diary();
    delete (((missing.parts as Json[])[0] as Json).fields as Json[])[1]?.required;
    expect(failure(() => read(missing)).unsupported).toBe(true);
  });

  const field = (id: string) => ({ id, label: "Value", type: "number", required: false });
  it.each([
    ["/parts/0/fields", [], "parts[0].fields"],
    ["/parts/0/fields", Array.from({ length: 17 }, (_, n) => field(`v${n}`)), "parts[0].fields"],
    ["/parts/0/fields/1/id", "date", "parts[0].fields[1].id"],
    ["/parts/0/fields/1/id", "Meal", "parts[0].fields[1].id"],
    ["/parts/0/fields/1/label", " 　 ", "parts[0].fields[1].label"],
    ["/parts/0/fields/1/label", "x".repeat(121), "parts[0].fields[1].label"],
    ["/parts/0/fields/1/label", "Meal‮", "parts[0].fields[1].label"],
    ["/parts/0/fields/1/label", "Me\0al", "parts[0].fields[1].label"],
    ["/parts/0/summaryField", "meal", "parts[0].summaryField"],
    ["/parts/0/summaryField", "calories", "parts[0].summaryField"],
  ])("matches the registry's app limits: %s = %j", (pointer, value, path) => {
    const error = failure(() => normalizeRegistryManifest(read(edit(diary(), pointer, value))));
    expect(error.unsupported).toBe(false);
    expect(error.path).toBe(path);
  });

  it("accepts sixteen fields and measures labels before trimming", () => {
    const sixteen = diary();
    edit(
      sixteen,
      "/parts/0/fields",
      Array.from({ length: 16 }, (_, n) => field(`v${n}`)),
    );
    edit(sixteen, "/parts/0/summaryField", "v15");
    expect(() => normalizeRegistryManifest(read(sixteen))).not.toThrow();

    const padded = edit(diary(), "/parts/0/fields/1/label", ` ${"x".repeat(118)} `);
    expect(fields(normalizeRegistryManifest(read(padded))).fields[1]?.label).toBe("x".repeat(118));
    edit(padded, "/parts/0/fields/1/label", ` ${"x".repeat(119)} `);
    expect(() => normalizeRegistryManifest(read(padded))).toThrow(RegistryManifestError);
  });

  it("round-trips both command-line templates", () => {
    const starter = normalizeRegistryManifest(read(skill()));
    expect(readRegistryManifest(bytes(registryManifestText(starter)))).toEqual(starter);

    const converter = normalizeRegistryManifest(readRegistryManifest(bytes(MCP_APP)));
    expect(converter.parts[0]).toEqual({
      kind: "mcp",
      id: "temperatures",
      transport: "streamable_http",
      endpoint: "https://units.example.com/mcp",
    });
    const again = normalizeRegistryManifest(
      readRegistryManifest(bytes(registryManifestText(converter))),
    );
    expect(registryManifestText(again)).toBe(registryManifestText(converter));
    expect(registryManifestText(converter)).toContain('"transport": "streamable_http"');
  });

  it("refuses by name what a plugin cannot carry", () => {
    const headers = app();
    ((headers.parts as Json[])[0] as Json).headers = { Authorization: "x" };
    const error = failure(() => read(headers));
    expect(error.unsupported).toBe(true);
    expect(error.path).toBe("parts[0].headers");
    expect(error.message).toContain("can't carry secrets or commands. Remove “headers”");

    expect(failure(() => read({ ...skill(), slug: "release-notes" })).message).toContain(
      "no “slug” field",
    );
    for (const [pointer, value] of [
      ["/schemaVersion", 2],
      ["/parts/0/kind", "hook"],
      ["/parts", {}],
      ["/name", 7],
    ] as const) {
      expect(failure(() => read(edit(skill(), pointer, value))).unsupported).toBe(true);
    }
    expect(failure(() => read(edit(app(), "/parts/0/transport", "stdio"))).unsupported).toBe(true);
    expect(failure(() => readRegistryManifest(bytes("{ not json"))).unsupported).toBe(true);
  });

  it("refuses a byte-order mark, invalid UTF-8 and an oversized file", () => {
    expect(failure(() => readRegistryManifest(bytes(`﻿${KCAL_DIARY}`))).unsupported).toBe(true);
    expect(failure(() => readRegistryManifest(new Uint8Array([0x7b, 0xff, 0x7d]))).path).toBe("");
    const huge = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x20);
    expect(failure(() => readRegistryManifest(huge)).message).toBe(
      "This file is too large to be a plugin manifest.",
    );
  });

  it("keeps values outside the limits until normalized", () => {
    const long = edit(skill(), "/name", "😀".repeat(61));
    const kept = read(long);
    expect(kept.name).toBe("😀".repeat(61));
    const error = failure(() => normalizeRegistryManifest(kept));
    expect(error.unsupported).toBe(false);
    expect(error.path).toBe("name");

    for (const [pointer, value, path] of [
      ["/description", " ", "description"],
      ["/parts/0/id", "double--hyphen", "parts[0].id"],
      ["/parts/0/instructions", "x".repeat(16001), "parts[0].instructions"],
    ] as const) {
      expect(
        failure(() => normalizeRegistryManifest(read(edit(skill(), pointer, value)))).path,
      ).toBe(path);
    }
    for (const endpoint of [
      "http://units.example.com/mcp",
      "https://units.example.com/mcp?",
      "https://units.example.com/mcp#",
      "https://user:pass@units.example.com/mcp",
    ]) {
      const error = failure(() =>
        normalizeRegistryManifest(read(edit(app(), "/parts/0/endpoint", endpoint))),
      );
      expect(error.path).toBe("parts[0].endpoint");
    }
    const twice = edit(app(), "/parts/1/id", "temperatures");
    expect(failure(() => normalizeRegistryManifest(read(twice))).message).toContain("Two parts");
  });

  it("trims text and normalizes endpoints as the registry does", () => {
    const manifest = normalizeRegistryManifest(
      readRegistryManifest(
        bytes(
          JSON.stringify({
            schemaVersion: 1,
            name: "﻿Release notes ",
            description: "Draft notes.",
            parts: [
              { kind: "skill", id: "notes", instructions: " Summarize the issues. " },
              {
                kind: "mcp",
                id: "tracker",
                transport: "streamable_http",
                endpoint: " https://plugin.example.test/mc\np ",
              },
            ],
          }).replace('"schemaVersion":1', '"schemaVersion":1.0'),
        ),
      ),
    );
    expect(manifest.name).toBe("Release notes");
    expect(manifest.parts).toEqual([
      { kind: "skill", id: "notes", instructions: "Summarize the issues." },
      {
        kind: "mcp",
        id: "tracker",
        transport: "streamable_http",
        endpoint: "https://plugin.example.test/mcp",
      },
    ]);
  });

  it("locates errors for command-line output", () => {
    expect(
      failure(() => normalizeRegistryManifest(read(edit(skill(), "/name", " ")))).located(),
    ).toBe("name: Give the plugin a name.");
    expect(failure(() => readRegistryManifest(bytes("[]"))).located()).toBe(
      "The manifest must be a JSON object.",
    );
  });
});

function addField(manifest: Json, key: string, value: unknown): Json {
  const first = (((manifest.parts as Json[])[0] as Json).fields as Json[])[0] as Json;
  first[key] = value;
  return manifest;
}
