import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SettingsEnvironment } from "@rakazo/cli-client";
import { settingsDirectory } from "@rakazo/cli-client";
import { CommandError } from "../output/errors.js";

/** A model of a CLI installed on this device, as the desktop app saved it for an agent. */
export type InstalledModel = { provider: string; id: string; label: string };

/** A local turn kept for `/retry` until the server has saved it. */
export type PendingHistory = { id: string; text: string; reply: string | null };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The local model settings of one account in one Space on one server: which installed model each
 * agent uses, and turns that ran locally but are not yet saved. The same files the desktop app and
 * earlier command-line releases use.
 */
export class LocalModelStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** The store for this server, account and Space, or undefined without a settings directory. */
  static forWorkspace(
    settings: SettingsEnvironment,
    server: string,
    account: string,
    space: string,
  ): LocalModelStore | undefined {
    if (account === "") return undefined;
    const data = settingsDirectory(settings);
    if (!data) return undefined;
    const scope = createHash("sha256");
    for (const value of [server, account, space]) {
      const bytes = Buffer.from(value, "utf8");
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(bytes.length));
      scope.update(size).update(bytes);
    }
    return new LocalModelStore(path.join(data, "local-models", scope.digest("hex")));
  }

  /** The installed model the agent uses on this device, or undefined for the server's model. */
  async selection(bot: string): Promise<InstalledModel | undefined> {
    const text = await this.#read(this.modelPath(bot), "Couldn't read the local model selection.");
    if (text === undefined) return undefined;
    const model = parse(text, isInstalledModelOrNull, "The local model selection is invalid.");
    return model ?? undefined;
  }

  async pendingHistory(key: string): Promise<PendingHistory | undefined> {
    const problem = "Couldn't read the pending local reply.";
    const text = await this.#read(this.historyPath(key), problem);
    return text === undefined ? undefined : parse(text, isPendingHistory, problem);
  }

  /** Keeps a local turn for retry; one already kept for this chat is never replaced. */
  async stageHistory(key: string, pending: PendingHistory): Promise<void> {
    const problem = "Couldn't keep this local message for retry.";
    const target = this.historyPath(key);
    const staged = path.join(this.directory, `.pending-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const file = await open(staged, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(pending), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(staged, target);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        if (!samePending(await this.pendingHistory(key), pending)) throw error;
      }
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(problem);
    } finally {
      await rm(staged, { force: true });
    }
  }

  /** Removes the kept turn once saved, unless another turn has replaced it. */
  async clearHistory(key: string, pending: PendingHistory): Promise<void> {
    const problem = "Couldn't clear the saved local retry.";
    const target = this.historyPath(key);
    const claimed = path.join(this.directory, `.clearing-${randomUUID()}.tmp`);
    try {
      await rename(target, claimed);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw new CommandError(problem);
    }
    try {
      const kept = parse(await readFile(claimed, "utf8"), isPendingHistory, problem);
      if (!samePending(kept, pending)) {
        // A different turn was kept meanwhile: put it back for its own retry.
        await link(claimed, target).catch((error: unknown) => {
          if (!isCode(error, "EEXIST")) throw error;
        });
      }
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(problem);
    } finally {
      await rm(claimed, { force: true });
    }
  }

  historyPath(key: string): string {
    return path.join(this.directory, `pending-${sha256(key)}.json`);
  }

  modelPath(bot: string): string {
    return path.join(this.directory, `bot-${sha256(bot)}.json`);
  }

  async #read(file: string, problem: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw new CommandError(problem);
    }
  }
}

function parse<T>(text: string, check: (value: unknown) => value is T, problem: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CommandError(problem);
  }
  if (!check(value)) throw new CommandError(problem);
  return value;
}

function isInstalledModelOrNull(value: unknown): value is InstalledModel | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const { provider, id, label } = value as Record<string, unknown>;
  return typeof provider === "string" && typeof id === "string" && typeof label === "string";
}

function isPendingHistory(value: unknown): value is PendingHistory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (fields.reply === undefined) fields.reply = null;
  return (
    typeof fields.id === "string" &&
    typeof fields.text === "string" &&
    (fields.reply === null || typeof fields.reply === "string")
  );
}

function samePending(a: PendingHistory | undefined, b: PendingHistory): boolean {
  return a !== undefined && a.id === b.id && a.text === b.text && a.reply === b.reply;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
