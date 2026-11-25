import { deadlineSignal, retry, withAbort } from "@rakazo/core";
import type { Client } from "../client/client.js";
import { sessionToken } from "../client/client.js";
import { SuperbotError } from "../errors.js";
import type { SettingsEnvironment } from "../settings/settings-directory.js";
import { settingsFile } from "../settings/settings-directory.js";
import { forgetToken, readTokens, saveToken } from "./sessions-file.js";
import type { SystemCredentialStore } from "./system-store.js";
import { keychainStore, NoSystemStoreError } from "./system-store.js";

/** The credential store service the native apps save sessions under; the account is the server. */
export const SESSION_SERVICE = "com.superbot.rakazo.session";

/** Where a saved session went, so the caller can tell the person when it is a file. */
export type SavedSession = { kind: "systemStore" } | { kind: "file"; path: string };

/** How long restoring may spend on the network, and how its retries back off. */
export type RestoreTiming = { budgetMs: number; firstRetryMs: number; maxBackoffMs: number };

export const RESTORE_TIMING: RestoreTiming = {
  budgetMs: 10_000,
  firstRetryMs: 500,
  maxBackoffMs: 4_000,
};

export type CredentialStoreOptions = {
  /** The system store; defaults to this computer's. */
  systemStore?: SystemCredentialStore;
  settings?: SettingsEnvironment;
  restoreTiming?: RestoreTiming;
};

/**
 * Saves one signed session per server in the system credential store, or in `sessions.json`
 * (readable only by this user) when the computer has none.
 */
export class CredentialStore {
  readonly #system: SystemCredentialStore;
  readonly #settings: SettingsEnvironment;
  readonly #timing: RestoreTiming;

  constructor(options: CredentialStoreOptions = {}) {
    this.#system = options.systemStore ?? keychainStore(options.settings?.platform);
    this.#settings = options.settings ?? {};
    this.#timing = options.restoreTiming ?? RESTORE_TIMING;
  }

  /**
   * Restores the saved session and validates it with read-only requests. Unavailability and
   * network failures are retried within the time budget; only the server rejecting the session
   * removes it. Resolves undefined when nothing is saved or the session was rejected.
   */
  async restore<T>(
    client: Client,
    validate: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const saved = await this.load(client);
    if (!saved) return undefined;
    const { budgetMs, firstRetryMs, maxBackoffMs } = this.#timing;
    const deadline = Date.now() + budgetMs;
    const budget = deadlineSignal(budgetMs);
    let backoff = firstRetryMs;
    let wait = 0;
    try {
      return await withAbort(
        retry(() => validate(saved, budget), {
          attempts: Number.POSITIVE_INFINITY,
          signal: budget,
          retryable: (error) => {
            const delay = restoreRetryDelay(error, backoff, deadline - Date.now());
            if (delay === undefined) return false;
            wait = delay;
            backoff = Math.min(backoff * 2, maxBackoffMs);
            return true;
          },
          delayMs: () => wait,
        }),
        budget,
      );
    } catch (error) {
      const answered = error instanceof SuperbotError && !error.isRetryable();
      const failure = budget.aborted && !answered ? SuperbotError.unavailable() : error;
      if (failure instanceof SuperbotError && failure.isUnauthorized()) {
        try {
          await this.delete(saved);
        } catch {
          // The server already refuses the session, so a copy left behind signs no one in.
        }
        return undefined;
      }
      throw failure;
    }
  }

  /** The saved session for this client's server, or undefined when there is none. */
  async load(client: Client): Promise<Client | undefined> {
    let token: string | null;
    try {
      token = await this.#system.get(SESSION_SERVICE, client.server);
    } catch (error) {
      if (!(error instanceof NoSystemStoreError)) throw SuperbotError.credentialStore(error);
      token = null;
    }
    token ??= (await this.#fileToken(client.server)) ?? null;
    return token === null ? undefined : client.withToken(token);
  }

  /** Saves the client's signed session for its server. */
  async save(client: Client): Promise<SavedSession> {
    const token = sessionToken(client);
    if (token === undefined) throw SuperbotError.missingSession();
    const file = this.#sessionsFile();
    try {
      await this.#system.set(SESSION_SERVICE, client.server, token);
    } catch (error) {
      if (!(error instanceof NoSystemStoreError) || !file) {
        throw SuperbotError.credentialStore(error);
      }
      try {
        await saveToken(file, client.server, token);
      } catch (fileError) {
        throw SuperbotError.credentialStore(fileError);
      }
      return { kind: "file", path: file };
    }
    if (file) {
      // Tidies a session saved earlier without a system store. Loading reads the system store
      // first, so a file that cannot be tidied never wins.
      try {
        await forgetToken(file, client.server);
      } catch {
        // The system store copy is the one in use.
      }
    }
    return { kind: "systemStore" };
  }

  /** Removes the saved session for this client's server from both places. */
  async delete(client: Client): Promise<void> {
    try {
      await this.#system.delete(SESSION_SERVICE, client.server);
    } catch (error) {
      if (!(error instanceof NoSystemStoreError)) throw SuperbotError.credentialStore(error);
    }
    const file = this.#sessionsFile();
    if (!file) return;
    try {
      await forgetToken(file, client.server);
    } catch (error) {
      throw SuperbotError.credentialStore(error);
    }
  }

  #sessionsFile(): string | undefined {
    return settingsFile("sessions.json", this.#settings);
  }

  async #fileToken(server: string): Promise<string | undefined> {
    const file = this.#sessionsFile();
    if (!file) return undefined;
    try {
      return (await readTokens(file)).get(server);
    } catch (error) {
      throw SuperbotError.credentialStore(error);
    }
  }
}

/**
 * The wait before validating again, or undefined to stop: only a failure that may pass is retried,
 * never sooner than the server's Retry-After, and never past the remaining budget.
 */
export function restoreRetryDelay(
  error: unknown,
  backoffMs: number,
  remainingMs: number,
): number | undefined {
  if (!(error instanceof SuperbotError) || !error.isRetryable()) return undefined;
  const delay =
    error.kind === "unavailable" && error.retryAfterMs !== undefined
      ? Math.max(backoffMs, error.retryAfterMs)
      : backoffMs;
  return delay < remainingMs ? delay : undefined;
}
