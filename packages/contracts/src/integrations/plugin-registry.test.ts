import { describe, expect, it } from "vitest";
import { pluginRegistryRpc, RegistryPluginManifestSchema } from "./plugin-registry.js";

const skill = { id: "notes", kind: "skill", instructions: "Summarize the provided issues." };
const mcp = {
  id: "tracker",
  kind: "mcp",
  transport: "streamable_http",
  endpoint: "https://plugin.example.test/mcp",
};
const manifest = { schemaVersion: 1, name: "Release notes", description: "Draft release notes." };
const app = {
  id: "tracker-app",
  kind: "app",
  fields: [
    { id: "day", label: "Day", type: "date", required: true },
    { id: "amount", label: "Amount", type: "number", required: true },
  ],
  summaryField: "amount",
};

describe("Plugin registry manifest", () => {
  it("accepts declarative skills, apps and HTTPS MCP parts", () => {
    expect(RegistryPluginManifestSchema.parse({ ...manifest, parts: [skill, mcp, app] })).toEqual({
      ...manifest,
      parts: [skill, mcp, app],
    });
  });

  it.each([
    { ...manifest, commands: ["run"], parts: [skill] },
    { ...manifest, parts: [skill, { ...mcp, id: skill.id }] },
    { ...manifest, parts: [{ ...mcp, transport: "stdio", command: "launch" }] },
    { ...manifest, parts: [{ ...mcp, headers: { authorization: "secret" } }] },
    { ...manifest, parts: [{ ...mcp, endpoint: "http://plugin.example.test/mcp" }] },
    { ...manifest, parts: [{ ...mcp, endpoint: "https://user:pass@plugin.example.test/mcp" }] },
    { ...manifest, parts: [{ ...mcp, endpoint: "https://plugin.example.test/mcp?token=secret" }] },
    { ...manifest, parts: [{ ...app, summaryField: "day" }] },
    { ...manifest, parts: [{ ...app, summaryField: "unknown" }] },
    { ...manifest, parts: [{ ...app, fields: [app.fields[0], app.fields[0]] }] },
    { ...manifest, parts: [{ ...app, fields: [] }] },
    { ...manifest, parts: [{ ...app, fields: [{ ...app.fields[0], type: "url" }] }] },
    { ...manifest, parts: [{ ...app, fields: [{ ...app.fields[0], label: "\u202E" }] }] },
    { ...manifest, parts: [{ ...app, instructions: "Run a command" }] },
  ])("rejects unsupported or ambiguous manifests", (value) => {
    expect(RegistryPluginManifestSchema.safeParse(value).success).toBe(false);
  });
});

it("validates and trims search text for approved registry discovery", () => {
  const input = pluginRegistryRpc.pluginRegistry.discover["~orpc"].inputSchema!;
  expect(input.parse({})).toEqual({ limit: 20 });
  expect(input.parse({ query: "  RELEASE NOTES  ", after: "cursor" })).toEqual({
    limit: 20,
    query: "RELEASE NOTES",
    after: "cursor",
  });
  for (const query of ["  ", "x".repeat(121), "x\0y"]) {
    expect(input.safeParse({ query }).success).toBe(false);
  }
});
