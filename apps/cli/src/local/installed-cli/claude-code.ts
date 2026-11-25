import { LocalModelError } from "../local-model-error.js";
import type { ProcessOutput } from "../process.js";

/** Settings that leave the CLI no connectors, hooks or permissions of its own. */
const SETTINGS =
  '{"disableClaudeAiConnectors":true,"disableAllHooks":true,"permissions":{"deny":["*"]}}';

export function claudeAuthArgs(): string[] {
  return ["auth", "status", "--json"];
}

/** One prompt-only turn: no tools, MCP servers, settings sources, sessions or slash commands. */
export function claudeReplyArgs(model: string): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--settings",
    SETTINGS,
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "1",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
}

export function claudeReply(output: ProcessOutput): string {
  let result: { is_error?: unknown; result?: unknown } | undefined;
  try {
    result = JSON.parse(output.stdout) as typeof result;
  } catch {
    result = undefined;
  }
  if (
    output.success &&
    result?.is_error === false &&
    typeof result.result === "string" &&
    result.result.trim() !== ""
  ) {
    return result.result;
  }
  throw new LocalModelError(
    "Claude Code didn't return a reply. Check the provider account and model access.",
  );
}
