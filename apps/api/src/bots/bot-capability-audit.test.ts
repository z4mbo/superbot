import { describe, expect, it } from "vitest";
import { renderBotCapabilityAudit } from "./bot-capability-audit.js";

const space = (
  spaceId: string,
  missing: { thread: number; memoryIndex: number; computer: number },
) => ({
  spaceId,
  bots: 3,
  missing,
  leftAsStored: { fleetManagementOff: 2, crossSpaceCommunicationOff: 1 },
});

describe("bot capability audit report", () => {
  it("prints counts per Space and totals what is missing", () => {
    const report = renderBotCapabilityAudit([
      space("space_a", { thread: 1, memoryIndex: 2, computer: 0 }),
      space("space_b", { thread: 0, memoryIndex: 0, computer: 0 }),
    ]);
    expect(report.missing).toBe(3);
    expect(report.text).toBe(
      [
        "space space_a: 3 bots; missing chat 1, memory index 2, computer 0; left as stored: fleet management off 2, cross-space off 1",
        "space space_b: 3 bots; missing chat 0, memory index 0, computer 0; left as stored: fleet management off 2, cross-space off 1",
        "total: 6 bots in 2 spaces; 3 missing capabilities",
        "",
      ].join("\n"),
    );
  });

  it("reports nothing missing for an install with no gaps or no bots", () => {
    expect(
      renderBotCapabilityAudit([space("space_a", { thread: 0, memoryIndex: 0, computer: 0 })])
        .missing,
    ).toBe(0);
    expect(renderBotCapabilityAudit([])).toEqual({
      text: "total: 0 bots in 0 spaces; 0 missing capabilities\n",
      missing: 0,
    });
  });
});
