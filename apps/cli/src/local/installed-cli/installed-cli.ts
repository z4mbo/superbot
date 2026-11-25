import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LocalModelError } from "../local-model-error.js";
import type { InstalledModel, LocalModelStore } from "../local-model-store.js";
import type { Command, ProcessOutput } from "../process.js";
import {
  executableName,
  ProcessFailure,
  pathDirectories,
  pickEnvironment,
  runCommand,
  withTemporaryDirectory,
} from "../process.js";
import { claudeAuthArgs, claudeReply, claudeReplyArgs } from "./claude-code.js";
import { codexAuthArgs, codexReply, codexReplyArgs } from "./codex.js";

const MAX_OUTPUT = 1024 * 1024;
const MAX_INPUT = 128 * 1024;

/** The CLIs with their own prompt-only local driver, by the provider ID a selection names. */
const DRIVERS = {
  claude: { minimum: [2, 1, 280] },
  codex: { minimum: [0, 170, 0] },
} as const;
export type DriverId = keyof typeof DRIVERS;

export function isDriverProvider(provider: string): provider is DriverId {
  return Object.hasOwn(DRIVERS, provider);
}

type Status =
  | "missing"
  | "unsupportedVersion"
  | "installedCodexUnavailable"
  | "installedCodexInstructions"
  | "signedOut"
  | "ready"
  | "unavailable";

const STATUS_LABELS: Record<Status, string> = {
  missing: "CLI installation missing.",
  unsupportedVersion: "Update the CLI to use local chat.",
  signedOut: "Sign in with the installed CLI.",
  ready: "Signed in on this computer.",
  installedCodexUnavailable:
    "Installed Codex needs a file-backed ChatGPT login and a compatible CLI home.",
  installedCodexInstructions: "Installed Codex has global instructions. Use a separate sign-in.",
  unavailable: "Couldn't verify CLI sign-in.",
};

const failed = () => new LocalModelError("Couldn't run the installed CLI.");

/** The variables an installed CLI may see from this process. */
const ALLOWED_ENV = [
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LC_ALL",
  "LC_CTYPE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "COMSPEC",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function modelIdOk(id: string): boolean {
  return (
    id !== "" &&
    Buffer.byteLength(id) <= 180 &&
    !id.startsWith("-") &&
    /^[A-Za-z0-9\-._:/[\]]+$/.test(id)
  );
}

/** Where to look for an installed CLI: PATH, the per-user bin folder, and Homebrew on macOS. */
async function installedExecutable(provider: DriverId): Promise<string | undefined> {
  const profile = process.env.USERPROFILE ?? process.env.HOME;
  const directories = [
    ...pathDirectories(),
    ...(profile ? [path.join(profile, ".local", "bin")] : []),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
  ].filter((directory) => path.isAbsolute(directory));
  for (const directory of directories) {
    const file = path.join(directory, executableName(provider));
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Not installed in this folder.
    }
  }
  return undefined;
}

/**
 * Runs the prompt-only local drivers for one account's local model settings. Each CLI runs with
 * its own profile under those settings, a scratch working directory, and only the environment
 * it needs.
 */
export class InstalledCli {
  readonly #store: LocalModelStore;
  readonly #executable: (provider: DriverId) => Promise<string | undefined>;

  constructor(
    store: LocalModelStore,
    executable: (provider: DriverId) => Promise<string | undefined> = installedExecutable,
  ) {
    this.#store = store;
    this.#executable = executable;
  }

  /** The reply of the selected model to one prompt. */
  async reply(model: InstalledModel, prompt: string): Promise<string> {
    if (Buffer.byteLength(prompt) > MAX_INPUT) {
      throw new LocalModelError("This local conversation is too long. Start a fresh local chat.");
    }
    if (!isDriverProvider(model.provider)) {
      throw new LocalModelError("The selected local provider is unavailable.");
    }
    if (!modelIdOk(model.id)) throw new LocalModelError("The selected local model is invalid.");
    const provider = model.provider;
    const home = await this.#installedHome(provider);
    const status = await this.#status(provider, home);
    if (status !== "ready") throw new LocalModelError(STATUS_LABELS[status]);
    if (provider === "codex") {
      const output = await this.#run(
        provider,
        codexReplyArgs(model.id, home),
        prompt,
        180_000,
        home,
      );
      return codexReply(output);
    }
    const output = await this.#run(provider, claudeReplyArgs(model.id), prompt, 180_000);
    return claudeReply(output);
  }

  /** Whether this device's Codex sign-in is used instead of a separate one for Superbot. */
  async #usesInstalledCodex(): Promise<boolean> {
    try {
      const mode = await readFile(path.join(this.#store.directory, "codex-account"), "utf8");
      if (mode === "installed") return true;
      if (mode === "separate") return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    }
    throw new StatusError("unavailable");
  }

  async #installedHome(provider: DriverId): Promise<string | undefined> {
    try {
      if (provider !== "codex" || !(await this.#usesInstalledCodex())) return undefined;
      const configured = process.env.CODEX_HOME;
      const home = configured
        ? configured
        : path.join(
            (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ??
              homedir(),
            ".codex",
          );
      if (!path.isAbsolute(home) || !(await stat(home).catch(() => undefined))?.isDirectory()) {
        throw new StatusError("installedCodexUnavailable");
      }
      // Codex still reads global AGENTS files when told to ignore the user's configuration.
      for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
        const found = await lstat(path.join(home, name)).then(
          () => true,
          (error: unknown) =>
            !(error instanceof Error && "code" in error && error.code === "ENOENT"),
        );
        if (found) throw new StatusError("installedCodexInstructions");
      }
      return home;
    } catch (error) {
      if (error instanceof StatusError) throw new LocalModelError(STATUS_LABELS[error.status]);
      throw error;
    }
  }

  async #status(provider: DriverId, home: string | undefined): Promise<Status> {
    const version = await this.#version(provider);
    if (version !== "ready") return version;
    return this.#authStatus(provider, home);
  }

  async #version(provider: DriverId): Promise<Status> {
    if ((await this.#executable(provider)) === undefined) return "missing";
    let output: ProcessOutput;
    try {
      output = await this.#run(provider, ["--version"], undefined, 10_000);
    } catch {
      return "unavailable";
    }
    const parts = (output.stdout.split(/\s+/).find((part) => /^[0-9]/.test(part)) ?? "")
      .split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : undefined));
    const [major, minor, patch] = parts;
    if (!output.success || major === undefined || minor === undefined || patch === undefined) {
      return "unavailable";
    }
    const [wantMajor, wantMinor, wantPatch] = DRIVERS[provider].minimum;
    const newEnough =
      major !== wantMajor
        ? major > wantMajor
        : minor !== wantMinor
          ? minor > wantMinor
          : patch >= wantPatch;
    return newEnough ? "ready" : "unsupportedVersion";
  }

  async #authStatus(provider: DriverId, home: string | undefined): Promise<Status> {
    let output: ProcessOutput;
    try {
      const args = provider === "codex" ? codexAuthArgs(home) : claudeAuthArgs();
      output = await this.#run(provider, args, undefined, 10_000, home);
    } catch {
      return "unavailable";
    }
    if (provider === "codex") {
      for (const row of `${output.stdout}\n${output.stderr}`.split("\n")) {
        const text = row.trim().toLowerCase();
        if (output.success && text.startsWith("logged in using chatgpt")) return "ready";
        if (!output.success && text === "not logged in") {
          return home ? "installedCodexUnavailable" : "signedOut";
        }
      }
      return "unavailable";
    }
    let auth: { loggedIn?: unknown; authMethod?: unknown };
    try {
      auth = JSON.parse(output.stdout) as typeof auth;
    } catch {
      return "unavailable";
    }
    if (typeof auth.loggedIn !== "boolean") return "unavailable";
    if (
      output.success &&
      auth.loggedIn &&
      (auth.authMethod === "claude.ai" || auth.authMethod === "oauth")
    ) {
      return "ready";
    }
    return auth.loggedIn ? "unavailable" : "signedOut";
  }

  async #run(
    provider: DriverId,
    args: string[],
    input: string | undefined,
    timeoutMs: number,
    codexHome?: string,
  ): Promise<ProcessOutput> {
    const program = await this.#executable(provider);
    if (program === undefined) throw new LocalModelError(STATUS_LABELS.missing);
    const profile = path.join(this.#store.directory, provider);
    try {
      await mkdir(profile, { recursive: true });
    } catch {
      throw new LocalModelError("Couldn't open the local CLI profile.");
    }
    try {
      await mkdir(this.#store.directory, { recursive: true });
      return await withTemporaryDirectory(async (work) => {
        const env: Record<string, string> = {
          ...pickEnvironment(ALLOWED_ENV, true),
          HOME: profile,
          USERPROFILE: profile,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          ENABLE_TOOL_SEARCH: "false",
        };
        if (provider === "claude") env.CLAUDE_CONFIG_DIR = profile;
        else {
          env.CODEX_HOME = codexHome ?? profile;
          if (codexHome) env.CODEX_SQLITE_HOME = work;
        }
        const command: Command = { program, args, cwd: work, env };
        const captureStderr =
          provider === "codex" && args.at(-2) === "login" && args.at(-1) === "status";
        return runCommand(command, { input, timeoutMs, maxOutput: MAX_OUTPUT, captureStderr });
      }, this.#store.directory);
    } catch (error) {
      if (error instanceof LocalModelError) throw error;
      if (error instanceof ProcessFailure && error.reason === "timeout") {
        throw new LocalModelError("The local CLI timed out.");
      }
      throw failed();
    }
  }
}

class StatusError extends Error {
  readonly status: Status;

  constructor(status: Status) {
    super(STATUS_LABELS[status]);
    this.status = status;
  }
}
