import { describe, expect, it } from "vitest";
import { quoted, terminalText, textLines } from "../output/text.js";
import { discovery, loopback, rpc } from "../test/loopback.test-support.js";
import { scriptedIo } from "../test/scripted-io.test-support.js";
import type { Catalog } from "./catalog.js";
import { discover, findAgent, printCatalog } from "./catalog.js";

const twoSpaces = (): Catalog =>
  ["One", "Two"].map((name) => ({
    space: { id: name, name },
    agents: [{ id: name, name: "Research" }],
  }));

describe("agent names", () => {
  it("needs a choice between agents with the same name", () => {
    const catalog = twoSpaces();
    expect(() => findAgent(catalog, "research")).toThrow(
      'More than one agent matches "research". Select its space with --space or use the picker.',
    );
    expect(findAgent(catalog.slice(0, 1), "research").space.name).toBe("One");
  });

  it("prefers an exact name over a unique case-insensitive one", () => {
    const catalog: Catalog = [
      {
        space: { id: "space-1", name: "Personal" },
        agents: [
          { id: "a", name: "Scout" },
          { id: "b", name: "scout" },
          { id: "c", name: "Ada" },
        ],
      },
    ];
    expect(findAgent(catalog, "scout").agent.id).toBe("b");
    expect(findAgent(catalog, "ADA").agent.id).toBe("c");
    expect(() => findAgent(catalog, "SCOUT")).toThrow("More than one agent matches");
    expect(() => findAgent(catalog, "Nobody")).toThrow(
      'No agent named "Nobody". Run superbot list to see available agents.',
    );
  });

  it("strips terminal controls and quotes names as the Rust command did", () => {
    expect(terminalText("a\u001b]52;payload\u0007\r\nb")).toBe("a]52;payload\nb");
    expect(terminalText("tab\tkept\u009b")).toBe("tab\tkept");
    expect(quoted('Say "hi"\n')).toBe('"Say \\"hi\\"\\n"');
    expect(textLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(textLines("")).toEqual([]);
  });
});

describe("discover", () => {
  it("selects one Space by name and lists its agents", async () => {
    const server = await loopback(discovery());
    const catalog = await discover(server.client, "PERSONAL");
    server.assertDone();
    expect(catalog).toEqual([
      { space: { id: "space-1", name: "Personal" }, agents: [{ id: "bot-1", name: "Tools" }] },
    ]);
    const terminal = scriptedIo();
    printCatalog(terminal.io, catalog, false);
    expect(terminal.stdout()).toBe("Personal\n  Tools\n");
    const json = scriptedIo();
    printCatalog(json.io, catalog, true);
    expect(JSON.parse(json.stdout())).toEqual([
      { id: "space-1", name: "Personal", agents: [{ id: "bot-1", name: "Tools" }] },
    ]);
  });

  it("explains a missing or ambiguous Space", async () => {
    let server = await loopback(discovery().slice(0, 2));
    await expect(discover(server.client, "Team")).rejects.toThrow(
      'No space named "Team". Run superbot list to see available spaces.',
    );
    server = await loopback([
      rpc(
        "spaces/list",
        {},
        {
          current: { id: "space-1" },
          spaces: [
            { id: "space-1", name: "Team" },
            { id: "space-2", name: "team" },
          ],
        },
        { space: null },
      ),
      { ...discovery()[1], space: null } as ReturnType<typeof discovery>[number],
    ]);
    await expect(discover(server.client, "TEAM")).rejects.toThrow(
      'More than one space is named "TEAM". Use the picker to choose one.',
    );
  });
});
