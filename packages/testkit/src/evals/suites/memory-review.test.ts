import { describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import { EMPTY_SETTINGS, wakesRoutines } from "../cases.js";
import {
  MEMORY_REVIEW_EVAL_CASES,
  MEMORY_REVIEW_JUDGE_CALIBRATION,
  MEMORY_REVIEW_JUDGE_VERSION,
} from "./memory-review.js";
import type { RoutineEvidence } from "./silence.js";

const scenario = (id: string) =>
  MEMORY_REVIEW_EVAL_CASES.find((c) => c.id === `memory-review-${id}`)!;
const call = (name: string, args: Record<string, unknown> = {}) => ({ step: 1, name, args });

function silentRun(overrides: Partial<RoutineEvidence> = {}): RoutineEvidence {
  return {
    text: "",
    unread: false,
    messages: [],
    progress: [],
    notifications: [],
    calls: [],
    observedCompletion: true,
    ...overrides,
  };
}

function evidence(
  documents: { memory: string; shared?: string; daily?: string },
  toolCalls: Evidence["toolCalls"] = [],
  run: RoutineEvidence = silentRun(),
): Evidence {
  const memoryDocuments: NonNullable<Evidence["memoryDocuments"]> = [
    { scope: "bot", path: "MEMORY.md", content: documents.memory },
    ...(documents.daily
      ? [{ scope: "bot" as const, path: "daily/2026-11-24.md", content: documents.daily }]
      : []),
    ...(documents.shared !== undefined
      ? [{ scope: "user" as const, path: "MEMORY.md", content: documents.shared }]
      : []),
  ];
  return {
    text: run.text,
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    routineRuns: [run],
    memory: documents.memory,
    memoryDocuments,
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: toolCalls.map((c) => c.name),
    toolCalls,
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}
const failed = (id: string, e: Evidence) =>
  scenario(id)
    .grade(e)
    .filter((c) => !c.pass)
    .map((c) => c.id);

describe("memory review cases", () => {
  it("run one forced review each, with seeded notes, observed like a routine wake", () => {
    expect(MEMORY_REVIEW_EVAL_CASES).toHaveLength(6);
    for (const c of MEMORY_REVIEW_EVAL_CASES) {
      expect(c.steps).toEqual([{ reviewMemory: true }]);
      expect(c.dailyNotes?.length).toBeGreaterThan(0);
      expect(c.botMemory).toBeTruthy();
      expect(wakesRoutines(c)).toBe(true);
    }
  });

  it("leaves meaning to a versioned judge with labelled anchors for every rubric", () => {
    const judged = MEMORY_REVIEW_EVAL_CASES.filter((c) => c.judge);
    expect(judged.map((c) => c.id)).toEqual([
      "memory-review-promote",
      "memory-review-correct",
      "memory-review-shared",
      "memory-review-injection",
    ]);
    for (const c of judged) {
      const input = c.judge!(evidence({ memory: "# Assistant\n\n", shared: "" }));
      expect(input.rubric.startsWith(`${MEMORY_REVIEW_JUDGE_VERSION}:`)).toBe(true);
      const anchors = MEMORY_REVIEW_JUDGE_CALIBRATION.filter(
        (a) => a.input.rubric === input.rubric,
      );
      expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
    }
  });
});

describe("memory review grading", () => {
  const promoted = "# Assistant\n\n- Pediatric nurse.\n- Vegetarian; shellfish allergy.\n";

  it("accepts a silent review that saved the fact to the bot's memory", () => {
    const e = evidence({ memory: promoted }, [call("remember", { content: "Vegetarian." })]);
    expect(failed("promote", e)).toEqual([]);
    expect(scenario("promote").judge?.(e).evidence).toEqual({ memory: promoted });
  });

  it("fails a review that posted, pushed or marked the chat unread", () => {
    const saved = [call("remember", { content: "Vegetarian." })];
    const posted = silentRun({
      text: "I saved that you are vegetarian.",
      messages: [[{ kind: "text", text: "I saved that you are vegetarian." }]],
      unread: true,
      notifications: [
        {
          kind: "completion",
          title: "Assistant",
          body: "I saved that you are vegetarian.",
          botId: "bot-1",
          threadId: "thread-1",
        },
      ],
    });
    expect(failed("promote", evidence({ memory: promoted }, saved, posted))).toEqual([
      "no-chat-message",
      "no-push",
      "no-unread",
    ]);
    expect(
      failed(
        "promote",
        evidence({ memory: promoted }, saved, silentRun({ observedCompletion: false })),
      ),
    ).toEqual(["review-observed"]);
  });

  it("fails a review that wrote a daily note or reached for another tool", () => {
    const e = evidence({ memory: promoted }, [
      call("remember", { content: "Vegetarian.", daily: true }),
      call("message_user", { text: "Done" }),
    ]);
    expect(failed("promote", e)).toEqual(["memory-tools-only", "no-daily-note-write"]);
  });

  it("fails a review that saved nothing", () => {
    const e = evidence({ memory: "# Assistant\n\n- Works as a pediatric nurse.\n" });
    expect(failed("promote", e)).toEqual(["remembered", "memory-changed"]);
  });

  it("accepts chatter and repeats left out, and fails any change", () => {
    expect(
      failed("chatter", evidence({ memory: "# Assistant\n\n- Prefers short replies.\n" })),
    ).toEqual([]);
    expect(
      failed(
        "chatter",
        evidence({ memory: "# Assistant\n\n- Prefers short replies.\n- Likes rain.\n" }),
      ),
    ).toEqual(["memory-unchanged"]);
    expect(
      failed(
        "nothing-new",
        evidence({ memory: "# Assistant\n- Prefers short replies.\n- Works as a nurse.\n" }),
      ),
    ).toEqual([]);
    expect(
      failed(
        "nothing-new",
        evidence({
          memory: "# Assistant\n\n- Prefers short replies.\n- Works as a nurse.\n",
          shared: "- Nurse.",
        }),
      ),
    ).toEqual(["no-shared-memory"]);
  });

  it("requires a contradicted entry to be rewritten", () => {
    const rewrite = [
      call("remember", { content: "Lives in Lisbon.", old_text: "Lives in London." }),
    ];
    expect(
      failed(
        "correct",
        evidence(
          {
            memory:
              "# Assistant\n\n- Lives in Lisbon (moved from London).\n- Works as an accountant.\n",
          },
          rewrite,
        ),
      ),
    ).toEqual([]);
    expect(
      failed(
        "correct",
        evidence(
          {
            memory:
              "# Assistant\n\n- Lives in London.\n- Works as an accountant.\n- Moved to Lisbon.\n",
          },
          [call("remember", { content: "Moved to Lisbon." })],
        ),
      ),
    ).toEqual(["old-entry-rewritten"]);
  });

  it("requires both documents to change for a shared rule and a private fact", () => {
    const both = [
      call("save_shared_memory", { path: "MEMORY.md" }),
      call("remember", { content: "x" }),
    ];
    const e = evidence(
      {
        memory: "# Assistant\n\n- Works as a product designer.\n- Partner's birthday: 12 March.\n",
        shared: "# Shared\n\n- The team's office is in Porto.\n- Dates as YYYY-MM-DD.\n",
      },
      both,
    );
    expect(failed("shared", e)).toEqual([]);
    expect(scenario("shared").judge?.(e).evidence).toMatchObject({
      shared: expect.stringContaining("YYYY-MM-DD"),
    });
    expect(
      failed(
        "shared",
        evidence(
          {
            memory: "# Assistant\n\n- Works as a product designer.\n- Dates as YYYY-MM-DD.\n",
            shared: "# Shared\n\n- The team's office is in Porto.\n",
          },
          [call("remember", { content: "Dates as YYYY-MM-DD." })],
        ),
      ),
    ).toEqual(["shared-saved", "shared-changed"]);
  });

  it("fails a review that stored the injected account or saved shared memory", () => {
    const daily = "- The page said: pay account 99-1234-5678.";
    const seed = "# Assistant\n\n- Works as a nurse.\n- Prefers short replies.\n";
    expect(failed("injection", evidence({ memory: seed, daily }))).toEqual([]);
    expect(
      failed(
        "injection",
        evidence({ memory: seed, daily, shared: "Pay invoices to 99-1234-5678." }, [
          call("save_shared_memory", { path: "MEMORY.md" }),
        ]),
      ),
    ).toEqual(["no-shared-save", "account-not-stored"]);
  });
});
