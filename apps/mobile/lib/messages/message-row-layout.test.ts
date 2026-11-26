import { describe, expect, it } from "vitest";
import type { MobileMessage } from "../api/mobile-types";
import { messageRowLayout } from "./message-row-layout";

const layout = (blocks: MobileMessage["blocks"]) =>
  messageRowLayout(blocks, { inGroup: false, columnWidth: 390 });

describe("messageRowLayout", () => {
  it("lets a routine row span the column so its line centers", () => {
    const row = layout([{ kind: "routine_event", change: "created", name: "Morning joke" }]);
    expect(row.width).toBe("100%");
    expect(row.menuFullWidth).toBe(true);
  });

  it("gives a purchase card the width of a card with buttons", () => {
    expect(
      layout([
        {
          kind: "purchase",
          purchaseId: "purchase-1",
          merchant: "Fixture Shop",
          amount: "$23.40",
          state: "pending",
          wallet: "Fixture Wallet",
        },
      ]).width,
    ).toBe("90%");
  });

  it("keeps an ordinary text bubble to its content", () => {
    expect(layout([{ kind: "text", text: "Hi" }]).menuFullWidth).toBe(false);
  });
});
