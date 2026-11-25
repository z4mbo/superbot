import { SuperbotError } from "@rakazo/cli-client";

/** Ends the command with this exit status once its output is printed. */
export class Exit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit status ${code}`);
    this.name = "Exit";
    this.code = code;
  }
}

/** A failure the command explains in its own words. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** What the command was doing when `cause` failed; printed as `context: cause`. */
export class ContextError extends Error {
  readonly context: string;

  constructor(context: string, cause: unknown) {
    super(`${context}: ${describeError(cause)}`, { cause });
    this.name = "ContextError";
    this.context = context;
  }
}

export function withContext(context: string, cause: unknown): ContextError {
  return new ContextError(context, cause);
}

/** The error's whole explanation, its causes included. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client error at the root of `error`, through any context added on the way. */
export function superbotCause(error: unknown): SuperbotError | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof SuperbotError) return cause;
  }
  return undefined;
}

export function isUnauthorized(error: unknown): boolean {
  return superbotCause(error)?.isUnauthorized() ?? false;
}

/** The server answered with this HTTP status. */
export function hasStatus(error: unknown, ...statuses: number[]): boolean {
  const cause = superbotCause(error);
  return cause?.kind === "server" && cause.status !== undefined && statuses.includes(cause.status);
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SuperbotError && error.isRetryable();
}

/** Points an expired or refused session at `superbot login`; other failures pass through. */
export function authHint(error: unknown): unknown {
  return error instanceof SuperbotError && error.isUnauthorized()
    ? withContext("Session expired or rejected. Run superbot login for this server", error)
    : error;
}

/** Rethrows a client failure with the sign-in hint. */
export async function hinted<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw authHint(error);
  }
}
