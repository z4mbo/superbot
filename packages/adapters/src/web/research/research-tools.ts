import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { researchKeyMissingReason } from "./research.prompt.js";
import { loadResearchKey } from "./research-keys.js";
import type { ResearchCallOptions } from "./research-provider.js";
import { ResearchProviderError } from "./research-provider.js";
import { researchProviderForTool } from "./research-providers.js";

export type ResearchToolDeps = {
  prisma: Pick<PrismaClient, "secret">;
  secrets: Pick<SecretStore, "load">;
} & Omit<ResearchCallOptions, "signal">;

/** The tool result, and the saved key the run must redact once it was read. */
export type ResearchToolOutcome = { result: unknown; redactions: string[] };

/**
 * Runs a research tool with the run owner's saved key. A missing key, a refused key or a provider
 * failure is a tool result the model can act on, never a thrown server error.
 */
export async function researchToolFromCall(
  deps: ResearchToolDeps,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ResearchToolOutcome> {
  const outcome = await researchResult(deps, userId, toolName, args, signal);
  return { result: outcome.result, redactions: outcome.key ? [outcome.key] : [] };
}

async function researchResult(
  deps: ResearchToolDeps,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ result: unknown; key?: string }> {
  const provider = researchProviderForTool(toolName);
  if (!provider) return { result: { error: `unknown tool ${toolName}` } };
  const { id, label } = provider.descriptor;
  let key: string | undefined;
  try {
    key = await loadResearchKey(deps, userId, id);
  } catch (error) {
    if (signal.aborted) throw error;
    getLogger().warn("research key could not be read", {
      provider: id,
      "error.name": errorName(error),
    });
    return {
      result: {
        error: `The saved ${label} key could not be read right now. Use web_search and web_fetch instead.`,
      },
    };
  }
  if (!key) return { result: { error: researchKeyMissingReason(toolName) } };
  try {
    return { result: withoutKey(await provider.run(args, key, { ...deps, signal }), key), key };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ResearchProviderError) {
      if (error.status !== undefined)
        getLogger().warn("research provider refused a call", {
          provider: id,
          status: error.status,
        });
      return { result: { error: withoutKey(error.message, key) }, key };
    }
    // Anything else could quote a request; only its kind is logged.
    getLogger().warn("research provider failed", { provider: id, "error.name": errorName(error) });
    return { result: { error: `${label} request failed.` }, key };
  }
}

/** A provider that echoed the key back never hands it to the model. */
function withoutKey(result: unknown, key: string): unknown {
  const text = JSON.stringify(result);
  const needle = JSON.stringify(key).slice(1, -1);
  return text.includes(needle) ? JSON.parse(text.replaceAll(needle, "[key]")) : result;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}
