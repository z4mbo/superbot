import type { Command } from "../process.js";
import { pickEnvironment } from "../process.js";

export type EngineErrorKind =
  | "unsupported"
  | "start"
  | "closed"
  | "timeout"
  | "limit"
  | "protocol"
  | "remote"
  | "authRequired"
  | "unsafe"
  | "unknownModel";

const MESSAGES: Record<EngineErrorKind, string> = {
  unsupported: "This provider has no supported local action.",
  start: "Could not start the local engine.",
  closed: "The local engine connection closed.",
  timeout: "The local engine took too long to respond.",
  limit: "The local engine exceeded a message size limit.",
  protocol: "The local engine returned an unexpected protocol message.",
  remote: "The local engine refused the request.",
  authRequired: "Sign in to the local engine and check again.",
  unsafe: "The local engine could not enforce prompt-only operation.",
  unknownModel: "The selected model is unavailable in this local session.",
};

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  /** The JSON-RPC error code of a refused request. */
  readonly code: number | undefined;

  constructor(kind: EngineErrorKind, code?: number) {
    super(MESSAGES[kind]);
    this.name = "EngineError";
    this.kind = kind;
    this.code = code;
  }
}

/** A local engine installed on this device and how to start it. */
export type Engine = {
  /** The provider ID a model selection names. */
  id: string;
  /** Agent Client Protocol over stdio, or the JSON RPC mode of the one engine without it. */
  protocol: "acp" | "pi";
  program: string;
  /** Arguments that come before the engine's own, such as a script for Node. */
  launcherArgs: string[];
  args: string[];
};

/** A local engine's text reply and why it stopped. */
export type EngineReply = { text: string; stopReason: string };

/** What every engine may see: platform essentials, never this process's other secrets. */
const PLATFORM_ENV = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** The provider credentials an engine reads from the environment, by provider ID. */
const CREDENTIAL_ENV: Record<string, string[]> = {
  githubCopilot: ["COPILOT_GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
  opencodeGo: ["OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  grok: ["GROK_HOME", "XAI_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  commandCode: ["COMMAND_CODE_API_KEY"],
  kiro: ["KIRO_API_KEY"],
  devin: ["WINDSURF_API_KEY"],
  mistralVibe: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gemini: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ],
};

/** The engine's program in `cwd` with a cleared environment and its launcher arguments. */
export function commandBase(engine: Engine, cwd: string): Command {
  return {
    program: engine.program,
    args: [...engine.launcherArgs],
    cwd,
    env: pickEnvironment(
      [...PLATFORM_ENV, ...(CREDENTIAL_ENV[engine.id] ?? [])],
      process.platform === "win32",
    ),
  };
}

export function field(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A property of a JSON object, or undefined. */
export function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
