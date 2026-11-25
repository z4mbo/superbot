import { getSystemErrorMessage } from "node:util";
import { RegistryManifestError } from "@rakazo/plugin-sdk/registry";

/** A failure the command reports as its own message, with no stack. */
export class CommandError extends Error {
  override name = "CommandError";
}

/** `error` with a line of context in front, the way every command reports a failed step. */
export function withContext(context: string, error: unknown): CommandError {
  return new CommandError(`${context}: ${errorText(error)}`, { cause: error });
}

/** How a failure reads after `Error: `. */
export function errorText(error: unknown): string {
  if (error instanceof RegistryManifestError) return error.located();
  const system = systemErrorText(error);
  if (system !== undefined) return system;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Where the system's wording differs from libuv's, the system's, as the tool has always shown it. */
const SYSTEM_WORDING: Record<string, string> = {
  EBUSY: "Device or resource busy",
  EEXIST: "File exists",
  EISDIR: "Is a directory",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
};

/**
 * A file system failure as the operating system words it, such as `No such file or directory
 * (os error 2)`, rather than Node's `ENOENT: ..., open 'path'`, which repeats the path.
 */
function systemErrorText(error: unknown): string | undefined {
  if (process.platform === "win32" || !(error instanceof Error)) return undefined;
  const { code, errno, syscall } = error as NodeJS.ErrnoException;
  if (typeof errno !== "number" || errno >= 0 || syscall === undefined) return undefined;
  const words = (code && SYSTEM_WORDING[code]) || getSystemErrorMessage(errno);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (os error ${-errno})`;
}
