import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemCredentialStore } from "@rakazo/cli-client";
import { CredentialStore, NoSystemStoreError } from "@rakazo/cli-client";
import { afterEach } from "vitest";
import type { CliContext } from "../session/context.js";
import type { Io } from "../terminal/io.js";

/** A terminal whose input is scripted and whose output is recorded. */
export function scriptedIo(
  options: {
    lines?: Array<string | null>;
    piped?: string;
    stdinIsTerminal?: boolean;
    stdoutIsTerminal?: boolean;
    stderrIsTerminal?: boolean;
  } = {},
) {
  const lines = [...(options.lines ?? [])];
  let stdout = "";
  let stderr = "";
  const io: Io = {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    stdinIsTerminal: options.stdinIsTerminal ?? false,
    stdoutIsTerminal: options.stdoutIsTerminal ?? false,
    stderrIsTerminal: options.stderrIsTerminal ?? false,
    async prompt(label) {
      stdout += label;
      return lines.length > 0 ? (lines.shift() ?? null) : null;
    },
    async secret(label) {
      stderr += label;
      return lines.shift() ?? "";
    },
    async readAll() {
      return options.piped ?? "";
    },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

/** A system credential store kept in memory, or one that reports there is none. */
export function memoryStore(available = true) {
  const saved = new Map<string, string>();
  const store: SystemCredentialStore = {
    async get(service, account) {
      if (!available) throw new NoSystemStoreError(new Error("Platform failure: none"));
      return saved.get(`${service} ${account}`) ?? null;
    },
    async set(service, account, secret) {
      if (!available) throw new NoSystemStoreError(new Error("Platform failure: none"));
      saved.set(`${service} ${account}`, secret);
    },
    async delete(service, account) {
      if (!available) throw new NoSystemStoreError(new Error("Platform failure: none"));
      saved.delete(`${service} ${account}`);
    },
  };
  return { store, saved };
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A context with a throwaway settings directory and an in-memory credential store, never the
 * person's own.
 */
export async function testContext(
  io: Io,
  options: { systemStore?: SystemCredentialStore; env?: Record<string, string> } = {},
): Promise<CliContext & { directory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "superbot-cli-"));
  directories.push(root);
  const directory = path.join(root, "settings");
  const settings = { env: { SUPERBOT_CONFIG_DIR: directory, ...options.env } };
  return {
    io,
    settings,
    credentials: new CredentialStore({
      systemStore: options.systemStore ?? memoryStore().store,
      settings,
    }),
    directory,
  };
}
