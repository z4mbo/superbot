import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type * as RunTools from "../runs/tools/run-tools.js";
import { applyNightlyMemoryReview, parseMemoryReviewReply } from "./nightly-memory-review-apply.js";

const dispatched = vi.hoisted(
  () => [] as Array<{ name: string; args: Record<string, unknown>; id: string }>,
);
const answers = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../runs/tools/run-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunTools>()),
  applyTool: vi.fn(
    async (_ctx: unknown, name: string, args: Record<string, unknown>, id: string) => {
      dispatched.push({ name, args, id });
      return answers.get(`${name}:${String(args.old_text ?? args.content)}`) ?? { ok: true };
    },
  ),
}));

function context(shared: Record<string, string> = {}) {
  const read = vi.fn(async ({ path }: { path: string }) => ({
    documents: path in shared ? [{ path, content: shared[path], revision: 1 }] : [],
  }));
  const ctx = {
    runId: "run-1",
    bot: { id: "bot-1" },
    deps: { memory: { read } },
    context: {},
    state: { approval: { pausePending: false } },
  } as unknown as RunContext;
  return { ctx, read };
}

beforeEach(() => {
  dispatched.length = 0;
  answers.clear();
});

describe("parseMemoryReviewReply", () => {
  it("reads the keep list, entry by entry", () => {
    expect(
      parseMemoryReviewReply(
        JSON.stringify({
          keep: [
            { fact: " Allergic to shellfish. ", scope: "private" },
            { fact: "Dates as YYYY-MM-DD.", scope: "shared", document: "Team.md" },
            { fact: "Lives in Lisbon.", replaces: "Lives in London." },
            { fact: "" },
            { scope: "shared" },
            "not an entry",
            { fact: "Odd scope.", scope: "public", daily: true },
          ],
        }),
      ),
    ).toEqual([
      { fact: "Allergic to shellfish.", scope: "private" },
      { fact: "Dates as YYYY-MM-DD.", scope: "shared", document: "Team.md" },
      { fact: "Lives in Lisbon.", scope: "private", replaces: "Lives in London." },
      { fact: "Odd scope.", scope: "private" },
    ]);
  });

  it("finds the object inside a code fence or after a sentence", () => {
    const fact = [{ fact: "Code is 4471-B.", scope: "private" }];
    expect(parseMemoryReviewReply('```json\n{"keep":[{"fact":"Code is 4471-B."}]}\n```')).toEqual(
      fact,
    );
    expect(
      parseMemoryReviewReply('Here is the list: {"keep": [{"fact": "Code is 4471-B."}]} Done.'),
    ).toEqual(fact);
  });

  it("accepts an empty list and tells a missing one apart", () => {
    expect(parseMemoryReviewReply('{"keep":[]}')).toEqual([]);
    expect(parseMemoryReviewReply("NO_RESPONSE")).toBeNull();
    expect(parseMemoryReviewReply("")).toBeNull();
    expect(parseMemoryReviewReply('{"facts":["x"]}')).toBeNull();
    expect(parseMemoryReviewReply('{"keep":[{"fact":"x"}')).toBeNull();
  });
});

describe("applyNightlyMemoryReview", () => {
  it("saves each private fact with remember, never as a daily note", async () => {
    const { ctx } = context();
    const reply = JSON.stringify({
      keep: [
        { fact: "The storage locker code is 4471-B.", scope: "private", daily: true },
        { fact: "Lives in Lisbon.", scope: "private", replaces: "Lives in London." },
      ],
    });
    expect(await applyNightlyMemoryReview(ctx, reply)).toEqual({ saved: 2, skipped: 0 });
    expect(dispatched).toEqual([
      {
        name: "remember",
        args: { content: "The storage locker code is 4471-B." },
        id: "memory-review-1",
      },
      {
        name: "remember",
        args: { content: "Lives in Lisbon.", old_text: "Lives in London." },
        id: "memory-review-2",
      },
    ]);
  });

  it("keeps a correction whose quoted entry does not match as a new fact", async () => {
    const { ctx } = context();
    answers.set("remember:Lives in Londn.", { error: "No entry contains old_text." });
    const reply = JSON.stringify({
      keep: [{ fact: "Lives in Lisbon.", replaces: "Lives in Londn." }],
    });
    expect(await applyNightlyMemoryReview(ctx, reply)).toEqual({ saved: 1, skipped: 0 });
    expect(dispatched.map((d) => d.args)).toEqual([
      { content: "Lives in Lisbon.", old_text: "Lives in Londn." },
      { content: "Lives in Lisbon." },
    ]);
  });

  it("counts a refused save as skipped", async () => {
    const { ctx } = context();
    answers.set("remember:Too long.", { error: "Memory is full." });
    expect(
      await applyNightlyMemoryReview(ctx, JSON.stringify({ keep: [{ fact: "Too long." }] })),
    ).toEqual({ saved: 0, skipped: 1 });
  });

  it("merges shared facts into each document and saves it once, keeping what it had", async () => {
    const { ctx, read } = context({
      "MEMORY.md": "# Shared\n\n- Office in Porto.\n- Standup at 9:00.\n",
    });
    const reply = JSON.stringify({
      keep: [
        { fact: "Dates as YYYY-MM-DD.", scope: "shared" },
        { fact: "Standup at 10:00.", scope: "shared", replaces: "Standup at 9:00." },
        { fact: "Office in Porto.", scope: "shared" },
        { fact: "Release train is Thursday.", scope: "shared", document: "Releases.md" },
      ],
    });
    expect(await applyNightlyMemoryReview(ctx, reply)).toEqual({ saved: 3, skipped: 0 });
    expect(read).toHaveBeenCalledWith({ scope: "user", path: "MEMORY.md" }, {});
    expect(dispatched).toEqual([
      {
        name: "save_shared_memory",
        args: {
          path: "MEMORY.md",
          content: "# Shared\n\n- Office in Porto.\n- Standup at 10:00.\n- Dates as YYYY-MM-DD.\n",
        },
        id: "memory-review-1",
      },
      {
        name: "save_shared_memory",
        args: { path: "Releases.md", content: "Release train is Thursday.\n" },
        id: "memory-review-2",
      },
    ]);
  });

  it("saves nothing for an empty list, a repeat, or a reply without a list", async () => {
    const { ctx } = context({ "MEMORY.md": "- Office in Porto.\n" });
    expect(await applyNightlyMemoryReview(ctx, '{"keep":[]}')).toEqual({ saved: 0, skipped: 0 });
    expect(
      await applyNightlyMemoryReview(
        ctx,
        JSON.stringify({ keep: [{ fact: "Office in Porto.", scope: "shared" }] }),
      ),
    ).toEqual({ saved: 0, skipped: 0 });
    expect(await applyNightlyMemoryReview(ctx, "NO_RESPONSE")).toBeNull();
    expect(dispatched).toEqual([]);
  });
});
