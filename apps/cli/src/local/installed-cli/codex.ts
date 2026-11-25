import { LocalModelError } from "../local-model-error.js";
import type { ProcessOutput } from "../process.js";

/** Keeps the sign-in in a file inside the CLI home this device already uses. */
const FILE_AUTH = 'cli_auth_credentials_store="file"';

export function codexAuthArgs(home: string | undefined): string[] {
  return home ? ["-c", FILE_AUTH, "login", "status"] : ["login", "status"];
}

/** One read-only, prompt-only turn with every tool, plugin and integration switched off. */
export function codexReplyArgs(model: string, home: string | undefined): string[] {
  const args = [
    "-a",
    "never",
    "exec",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--model",
    model,
    ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
    ...[
      "features.shell_tool=false",
      "features.shell_snapshot=false",
      "features.apply_patch_freeform=false",
      "features.browser_use=false",
      "features.browser_use_external=false",
      "features.computer_use=false",
      "features.hooks=false",
      "features.multi_agent=false",
      "features.plugins=false",
      "features.apps=false",
      "features.goals=false",
      "mcp_servers={}",
      'web_search="disabled"',
    ].flatMap((setting) => ["-c", setting]),
  ];
  if (home) {
    args.push(
      ...[
        FILE_AUTH,
        "skills.include_instructions=false",
        "project_doc_max_bytes=0",
        "features.skill_mcp_dependency_install=false",
        "features.skill_search=false",
        "features.memories=false",
      ].flatMap((setting) => ["-c", setting]),
    );
  }
  args.push("-");
  return args;
}

/** The agent message of a completed turn, from the CLI's JSON lines. */
export function codexReply(output: ProcessOutput): string {
  let completed = false;
  let reply: string | undefined;
  for (const row of output.stdout.split("\n")) {
    let event: { type?: unknown; item?: { type?: unknown; text?: unknown } };
    try {
      event = JSON.parse(row) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const text = event.item.text;
      reply = typeof text === "string" && text.trim() !== "" ? text : undefined;
    } else if (event.type === "turn.completed") {
      completed = true;
    } else if (event.type === "turn.failed") {
      throw new LocalModelError("The Codex turn failed.");
    }
  }
  if (reply !== undefined && completed && output.success) return reply;
  throw new LocalModelError(
    "Codex didn't return a reply. Check the provider account, sandbox and model access.",
  );
}
