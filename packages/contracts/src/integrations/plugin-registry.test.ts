import { describe, expect, it } from "vitest";
import { RegistryPluginManifestSchema } from "./plugin-registry.js";

const skill = { id: "notes", kind: "skill", instructions: "Summarize the provided issues." };
const mcp = {
  id: "tracker",
  kind: "mcp",
  transport: "streamable_http",
  endpoint: "https://plugin.example.test/mcp",
};
const manifest = { schemaVersion: 1, name: "Release notes", description: "Draft release notes." };

describe("Plugin registry manifest", () => {
  it("accepts declarative skills and HTTPS MCP parts", () => {
    expect(RegistryPluginManifestSchema.parse({ ...manifest, parts: [skill, mcp] })).toEqual({
      ...manifest,
      parts: [skill, mcp],
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
  ])("rejects unsupported or ambiguous manifests", (value) => {
    expect(RegistryPluginManifestSchema.safeParse(value).success).toBe(false);
  });
});
