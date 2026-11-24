import { MEMORY_INDEX_PATH } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { editMemory } from "../memory/memory-tools.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import { applyTool, isToolError } from "../runs/tools/run-tools.js";

/** More than a night of notes holds; the rest of a runaway list is dropped. */
const MAX_KEPT_FACTS = 40;

const KeptFactSchema = z.object({
  fact: z.string().trim().min(1),
  scope: z.enum(["private", "shared"]).catch("private"),
  document: z.string().trim().min(1).optional().catch(undefined),
  replaces: z.string().trim().min(1).optional().catch(undefined),
});
export type KeptFact = z.infer<typeof KeptFactSchema>;

const ReviewReplySchema = z.object({ keep: z.array(z.unknown()) });

function keptFacts(value: unknown): KeptFact[] | null {
  const reply = ReviewReplySchema.safeParse(value);
  if (!reply.success) return null;
  // Checked entry by entry: one malformed entry never costs the others.
  return reply.data.keep.slice(0, MAX_KEPT_FACTS).flatMap((entry) => {
    const parsed = KeptFactSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The facts a review's reply asks to keep, or null when it holds no keep list. Models wrap JSON
 * in a code fence or a sentence despite the instructions, so the last object that parses wins.
 */
export function parseMemoryReviewReply(text: string): KeptFact[] | null {
  const trimmed = text.trim();
  const end = trimmed.lastIndexOf("}");
  if (end === -1) return null;
  for (let start = trimmed.lastIndexOf("{", end); start !== -1; ) {
    try {
      const facts = keptFacts(JSON.parse(trimmed.slice(start, end + 1)));
      if (facts) return facts;
    } catch {
      // Not an object here: widen to the previous opening brace.
    }
    start = start === 0 ? -1 : trimmed.lastIndexOf("{", start - 1);
  }
  return null;
}

/**
 * Saves what the review's reply keeps, through the same dispatch, guards and audit a model's own
 * remember and save_shared_memory calls take. The product does the saving so a model that only
 * answers, and calls no tool, still keeps what matters. Nothing here writes a daily note.
 */
export async function applyNightlyMemoryReview(
  ctx: RunContext,
  text: string,
): Promise<{ saved: number; skipped: number } | null> {
  const facts = parseMemoryReviewReply(text);
  const log = { "run.id": ctx.runId, "bot.id": ctx.bot.id };
  if (!facts) {
    getLogger().warn("nightly memory review reply had no keep list", log);
    return null;
  }
  let saved = 0;
  let skipped = 0;
  let calls = 0;
  const dispatch = (name: string, args: Record<string, unknown>) => {
    calls += 1;
    return applyTool(ctx, name, args, `memory-review-${calls}`);
  };

  for (const fact of facts.filter((f) => f.scope === "private")) {
    let result = await dispatch("remember", {
      content: fact.fact,
      ...(fact.replaces ? { old_text: fact.replaces } : {}),
    });
    // An entry quoted loosely still keeps the new fact; a lost fact cannot be reviewed again.
    if (isToolError(result) && fact.replaces)
      result = await dispatch("remember", { content: fact.fact });
    if (isToolError(result)) skipped += 1;
    else saved += 1;
  }

  // One save per shared document: each save replaces the whole document.
  const shared = new Map<string, KeptFact[]>();
  for (const fact of facts.filter((f) => f.scope === "shared")) {
    const path = fact.document ?? MEMORY_INDEX_PATH;
    shared.set(path, [...(shared.get(path) ?? []), fact]);
  }
  for (const [path, group] of shared) {
    const snapshot = await ctx.deps.memory.read({ scope: "user", path }, ctx.context);
    const before = snapshot.documents[0]?.content ?? "";
    let content = before;
    let changed = 0;
    for (const fact of group) {
      // Written in the document's own style: a list stays a list.
      const entry = /^[-*] /m.test(content) ? `- ${fact.fact}` : fact.fact;
      let edit = editMemory(content, entry, fact.replaces ?? "", Number.POSITIVE_INFINITY);
      if ("error" in edit && fact.replaces)
        edit = editMemory(content, entry, "", Number.POSITIVE_INFINITY);
      if ("error" in edit) skipped += 1;
      else if (edit.content !== content) {
        content = edit.content;
        changed += 1;
      }
    }
    if (!changed) continue;
    const result = await dispatch("save_shared_memory", { path, content });
    if (isToolError(result)) skipped += changed;
    else saved += changed;
  }
  getLogger().info("nightly memory review applied", { ...log, saved, skipped });
  return { saved, skipped };
}
