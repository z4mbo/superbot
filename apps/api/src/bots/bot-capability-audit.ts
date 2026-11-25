import type { BotCapabilityAudit } from "@rakazo/db";
import { BOT_CAPABILITIES } from "@rakazo/db";

const LABELS = { thread: "chat", memoryIndex: "memory index", computer: "computer" } as const;

/** The audit as plain text, ids and counts only, and how many capabilities are missing. */
export function renderBotCapabilityAudit(spaces: readonly BotCapabilityAudit[]): {
  text: string;
  missing: number;
} {
  let missing = 0;
  let bots = 0;
  const lines = spaces.map((space) => {
    bots += space.bots;
    const gaps = BOT_CAPABILITIES.map((capability) => {
      missing += space.missing[capability];
      return `${LABELS[capability]} ${space.missing[capability]}`;
    });
    const stored = space.leftAsStored;
    return `space ${space.spaceId}: ${space.bots} bots; missing ${gaps.join(", ")}; left as stored: fleet management off ${stored.fleetManagementOff}, cross-space off ${stored.crossSpaceCommunicationOff}`;
  });
  lines.push(
    `total: ${bots} bots in ${spaces.length} spaces; ${missing} missing ${missing === 1 ? "capability" : "capabilities"}`,
  );
  return { text: `${lines.join("\n")}\n`, missing };
}
