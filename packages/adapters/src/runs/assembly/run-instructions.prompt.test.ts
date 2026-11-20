import { describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "../tools/run-tool-selection.js";
import {
  connectedPluginsInstruction,
  disabledBuiltinsForTurnInstructions,
  taughtSkillsInstruction,
  userTurnInstructions,
} from "./run-instructions.prompt.js";

describe("userTurnInstructions", () => {
  it.each([
    { trigger: "user", fleetManagement: true, expected: true },
    { trigger: "user", fleetManagement: false, expected: false },
    { trigger: "created", fleetManagement: true, expected: false },
  ])(
    "includes bot creation guidance: $expected for $trigger with fleet management $fleetManagement",
    ({ trigger, fleetManagement, expected }) => {
      const offered = selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        fleetManagement,
      });
      const instructions = userTurnInstructions({
        botInstructions: "",
        groupContext: undefined,
        messagingContext: undefined,
        redactedMemoryContext: undefined,
        redactedScratchpadContext: undefined,
        hasHistoricalContext: false,
        computerInstruction: "",
        pageBrowserAllowed: false,
        workspaceInstruction: "",
        agentEnvironmentInstruction: undefined,
        botDirectory: undefined,
        pluginLine: undefined,
        agentSkillsLine: undefined,
        taughtSkillsLine: undefined,
        replyGuidance: "",
        disabledBuiltinTools: disabledBuiltinsForTurnInstructions(new Set(), offered),
      }).join("\n");

      if (expected) {
        expect(instructions).toContain(
          "If the user asked to create a bot, call spawn_bot once and stop.",
        );
      } else {
        expect(instructions).not.toContain("spawn_bot");
      }
    },
  );
});

describe("connectedPluginsInstruction", () => {
  it("names each connected plugin and prefers its tools to browsing", () => {
    expect(
      connectedPluginsInstruction([
        { displayName: "Mail", connectorId: "apps", provider: "mail" },
        { displayName: "Code", connectorId: "apps", provider: "code" },
      ]),
    ).toBe(
      "Connected plugins: Mail (apps:mail), Code (apps:code). Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).",
    );
  });

  it("says so when nothing is connected", () => {
    expect(connectedPluginsInstruction([])).toBe("No plugins are connected yet.");
  });
});

describe("taughtSkillsInstruction", () => {
  it("lists each taught skill with when to use it", () => {
    expect(
      taughtSkillsInstruction([
        { name: "File expenses", whenToUse: "When a receipt arrives" },
        { name: "Book travel", whenToUse: "Book a trip" },
      ]),
    ).toBe(
      "Saved taught skills:\n- File expenses: When a receipt arrives\n- Book travel: Book a trip\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.",
    );
  });

  it("adds nothing when no skill was taught", () => {
    expect(taughtSkillsInstruction([])).toBeUndefined();
  });
});
