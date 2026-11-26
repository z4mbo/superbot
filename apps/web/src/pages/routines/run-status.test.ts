import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import { statusLabel, statusTone } from "./run-status";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

it("names each run status in words", () => {
  expect(
    (
      [
        "queued",
        "leased",
        "running",
        "waiting_input",
        "waiting_takeover",
        "completed",
        "failed",
        "cancelled",
      ] as const
    ).map(statusLabel),
  ).toEqual([
    "Queued",
    "Starting",
    "Running",
    "Needs input",
    "Needs takeover",
    "Done",
    "Failed",
    "Cancelled",
  ]);
});

it("colours a run by how it ended or what it waits for", () => {
  expect(statusTone("failed")).toBe("text-destructive");
  expect(statusTone("cancelled")).toBe("text-muted-foreground");
  expect(statusTone("completed")).toBe("text-success");
  expect(statusTone("waiting_input")).toBe("text-warning");
  expect(statusTone("waiting_takeover")).toBe("text-warning");
  expect(statusTone("running")).toBe("text-foreground");
});
