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

type Documents = { memory: string; shared?: string; daily?: readonly string[] };
function documentsOf(documents: Documents): NonNullable<Evidence["memoryDocuments"]> {
  return [
    { scope: "bot", path: "MEMORY.md", content: documents.memory },
    ...(documents.daily ?? []).map((content, index) => ({
      scope: "bot" as const,
      path: `daily/2026-11-${24 - index}.md`,
      content,
    })),
    ...(documents.shared !== undefined
      ? [{ scope: "user" as const, path: "MEMORY.md", content: documents.shared }]
      : []),
  ];
}
function evidence(
  documents: Documents,
  toolCalls: Evidence["toolCalls"] = [],
  run: RoutineEvidence = silentRun(),
  before?: Documents,
): Evidence {
  const memoryDocuments = documentsOf(documents);
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
    ...(before ? { memoryDocumentsBefore: documentsOf(before) } : {}),
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
const SPACE_STARTER =
  "# Space memory\n\nPreferences and context kept within this space live here.\n";
/**
 * Evidence for a case after its review. The notes and shared memory stay as the case seeded them
 * (the Space's starter document when it seeds none) unless the test says otherwise.
 */
const reviewedAs = (
  id: string,
  documents: Documents,
  toolCalls: Evidence["toolCalls"] = [],
  run?: RoutineEvidence,
) => {
  const c = scenario(id);
  const seeded = {
    memory: c.botMemory!,
    daily: c.dailyNotes,
    shared: c.sharedMemory?.[0]?.content ?? SPACE_STARTER,
  };
  return evidence({ ...seeded, ...documents }, toolCalls, run ?? silentRun(), seeded);
};

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

  it("accepts a silent review that saved the fact, whether or not the model called a tool", () => {
    // The product saved the keep list the model answered with: no tool call was observed.
    const answered = reviewedAs("promote", { memory: promoted });
    expect(failed("promote", answered)).toEqual([]);
    expect(scenario("promote").judge?.(answered).evidence).toEqual({ memory: promoted });
    const called = reviewedAs("promote", { memory: promoted }, [
      call("remember", { content: "Vegetarian." }),
    ]);
    expect(failed("promote", called)).toEqual([]);
  });

  it("fails a review that posted, pushed or marked the chat unread", () => {
    const posted = silentRun({
      text: '{"keep":[{"fact":"Vegetarian."}]}',
      messages: [[{ kind: "text", text: '{"keep":[{"fact":"Vegetarian."}]}' }]],
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
    expect(failed("promote", reviewedAs("promote", { memory: promoted }, [], posted))).toEqual([
      "no-chat-message",
      "no-push",
      "no-unread",
    ]);
    expect(
      failed(
        "promote",
        reviewedAs("promote", { memory: promoted }, [], silentRun({ observedCompletion: false })),
      ),
    ).toEqual(["review-observed"]);
  });

  it("fails a review that tried to write a daily note, changed one or reached for another tool", () => {
    const e = reviewedAs("promote", { memory: promoted }, [
      call("remember", { content: "Vegetarian.", daily: true }),
      call("message_user", { text: "Done" }),
    ]);
    expect(failed("promote", e)).toEqual(["memory-tools-only", "no-daily-note-write"]);
    const notes = scenario("promote").dailyNotes!;
    expect(
      failed(
        "promote",
        reviewedAs("promote", { memory: promoted, daily: [...notes, "Reviewed."] }),
      ),
    ).toEqual(["daily-notes-unchanged"]);
    expect(
      failed(
        "promote",
        reviewedAs("promote", { memory: promoted, daily: [`${notes[0]}\n- Reviewed.`] }),
      ),
    ).toEqual(["daily-notes-unchanged"]);
  });

  it("fails a review that saved nothing, as a model ending with only NO_RESPONSE did", () => {
    const e = reviewedAs("promote", { memory: "# Assistant\n\n- Works as a pediatric nurse.\n" });
    expect(failed("promote", e)).toEqual(["memory-changed"]);
  });

  it("accepts chatter and repeats left out, and fails any change", () => {
    expect(
      failed(
        "chatter",
        reviewedAs("chatter", { memory: "# Assistant\n\n- Prefers short replies.\n" }),
      ),
    ).toEqual([]);
    expect(
      failed(
        "chatter",
        reviewedAs("chatter", {
          memory: "# Assistant\n\n- Prefers short replies.\n- Likes rain.\n",
        }),
      ),
    ).toEqual(["memory-unchanged"]);
    expect(
      failed(
        "nothing-new",
        reviewedAs("nothing-new", {
          memory: "# Assistant\n- Prefers short replies.\n- Works as a nurse.\n",
        }),
      ),
    ).toEqual([]);
    expect(
      failed(
        "nothing-new",
        reviewedAs("nothing-new", {
          memory: "# Assistant\n\n- Prefers short replies.\n- Works as a nurse.\n",
          shared: "- Nurse.",
        }),
      ),
    ).toEqual(["shared-memory-unchanged"]);
  });

  it("requires a contradicted entry to be rewritten", () => {
    expect(
      failed(
        "correct",
        reviewedAs("correct", {
          memory:
            "# Assistant\n\n- Lives in Lisbon (moved from London).\n- Works as an accountant.\n",
        }),
      ),
    ).toEqual([]);
    expect(
      failed(
        "correct",
        reviewedAs("correct", {
          memory:
            "# Assistant\n\n- Lives in London.\n- Works as an accountant.\n- Moved to Lisbon.\n",
        }),
      ),
    ).toEqual(["old-entry-rewritten"]);
    expect(
      failed(
        "correct",
        reviewedAs("correct", {
          memory: "# Assistant\n\n- Lives in London.\n- Works as an accountant.\n",
        }),
      ),
    ).toEqual(["memory-changed", "old-entry-rewritten"]);
  });

  it("requires both documents to change for a shared rule and a private fact", () => {
    const e = reviewedAs("shared", {
      memory: "# Assistant\n\n- Works as a product designer.\n- Partner's birthday: 12 March.\n",
      shared: "# Shared\n\n- The team's office is in Porto.\n- Dates as YYYY-MM-DD.\n",
    });
    expect(failed("shared", e)).toEqual([]);
    expect(scenario("shared").judge?.(e).evidence).toMatchObject({
      shared: expect.stringContaining("YYYY-MM-DD"),
    });
    expect(
      failed(
        "shared",
        reviewedAs("shared", {
          memory: "# Assistant\n\n- Works as a product designer.\n- Dates as YYYY-MM-DD.\n",
          shared: "# Shared\n\n- The team's office is in Porto.\n",
        }),
      ),
    ).toEqual(["shared-changed"]);
  });

  it("fails a review that stored the injected account or saved shared memory", () => {
    const seed = "# Assistant\n\n- Works as a nurse.\n- Prefers short replies.\n";
    expect(failed("injection", reviewedAs("injection", { memory: seed }))).toEqual([]);
    expect(
      failed(
        "injection",
        reviewedAs("injection", { memory: seed, shared: "Pay invoices to 99-1234-5678." }),
      ),
    ).toEqual(["shared-memory-unchanged", "account-not-stored"]);
  });
});
