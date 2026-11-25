import type * as KeyringModule from "@napi-rs/keyring";

/**
 * The operating system's credential store: Windows Credential Manager, the macOS Keychain, or a
 * Linux Secret Service. Tests pass their own.
 */
export interface SystemCredentialStore {
  /** The saved secret, or null when there is none. */
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  /** Removes the secret; nothing saved is not an error. */
  delete(service: string, account: string): Promise<void>;
}

/**
 * This computer has no usable credential store, as opposed to a store that refused one request.
 * Sessions then go to the private sessions file instead.
 */
export class NoSystemStoreError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NoSystemStoreError";
  }
}

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux", "win32"];

/**
 * A store that cannot be reached at all reports one of these. Other failures (an ambiguous match,
 * a locked item, a value too long) are real errors and are not hidden by the file fallback.
 */
const NO_STORE_MESSAGE = /\b(?:Platform failure|Couldn't access platform storage):/;

type Keyring = typeof KeyringModule;
type KeyringEntry = InstanceType<Keyring["AsyncEntry"]>;

/**
 * The system store through the native keyring binding, loaded on first use so a computer without
 * a working binding or credential service falls back to the sessions file instead of failing.
 *
 * Entries match the ones earlier native releases and the desktop app wrote: the same service and
 * account on every platform, and on Linux the Secret Service's default collection with the
 * `default` target. Linux never falls back to the kernel keyring, which forgets on reboot.
 */
export function keychainStore(platform: NodeJS.Platform = process.platform): SystemCredentialStore {
  let keyring: Promise<Keyring> | undefined;
  const entry = async (service: string, account: string): Promise<KeyringEntry> => {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error("No system credential store is supported on this platform");
    }
    keyring ??= import("@napi-rs/keyring");
    let binding: Keyring;
    try {
      binding = await keyring;
    } catch (error) {
      throw new NoSystemStoreError(error);
    }
    try {
      return platform === "linux"
        ? binding.AsyncEntry.withTarget("default", service, account, {
            linux: { store: "secret-service" },
          })
        : new binding.AsyncEntry(service, account);
    } catch (error) {
      throw new NoSystemStoreError(error);
    }
  };
  return {
    async get(service, account) {
      const found = await entry(service, account);
      return storeCall(() => found.getPassword());
    },
    async set(service, account, secret) {
      const found = await entry(service, account);
      await storeCall(() => found.setPassword(secret));
    },
    async delete(service, account) {
      const found = await entry(service, account);
      await storeCall(() => found.deleteCredential());
    },
  };
}

async function storeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw isNoSystemStore(error) ? new NoSystemStoreError(error) : error;
  }
}

/** True when the binding reports that no credential store could be reached. */
export function isNoSystemStore(error: unknown): boolean {
  return error instanceof Error && NO_STORE_MESSAGE.test(error.message);
}
