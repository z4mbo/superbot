export const SERVER_UNREACHABLE =
  "Couldn't reach the server. Check that it is running and try again.";

export type SuperbotErrorKind =
  | "invalidServer"
  | "missingSession"
  | "invalidSession"
  | "invalidMessage"
  | "transport"
  | "unavailable"
  | "server"
  | "protocol"
  | "credentialStore";

type ErrorDetails = {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
};

/**
 * Every failure the client reports. `kind` says what failed; `status`, `code` and `retryAfterMs`
 * carry the server's answer when there was one.
 */
export class SuperbotError extends Error {
  readonly kind: SuperbotErrorKind;
  /** The HTTP status of a `server` error. */
  readonly status: number | undefined;
  /** The server's stable error code, when it sent one. */
  readonly code: string | undefined;
  /** How long an `unavailable` server asked clients to wait. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: SuperbotErrorKind, message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SuperbotError";
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** An expired or rejected session, or none at all. */
  isUnauthorized(): boolean {
    return this.kind === "missingSession" || (this.kind === "server" && this.status === 401);
  }

  /** Asking again can succeed: the request never got an answer, or a gateway had none. */
  isRetryable(): boolean {
    return this.kind === "transport" || this.kind === "unavailable";
  }

  static invalidServer(): SuperbotError {
    return new SuperbotError(
      "invalidServer",
      "Use an HTTPS Superbot origin or a local HTTP origin such as http://127.0.0.1:3000",
    );
  }

  static missingSession(): SuperbotError {
    return new SuperbotError("missingSession", "Sign in to Superbot first");
  }

  static invalidSession(): SuperbotError {
    return new SuperbotError("invalidSession", "Superbot did not provide a valid signed session");
  }

  static invalidMessage(): SuperbotError {
    return new SuperbotError(
      "invalidMessage",
      "Enter a message between 1 and 100,000 UTF-16 code units",
    );
  }

  static transport(cause: unknown): SuperbotError {
    return new SuperbotError("transport", `Could not reach Superbot: ${describe(cause)}`, {
      cause,
    });
  }

  static unavailable(retryAfterMs?: number): SuperbotError {
    return new SuperbotError("unavailable", SERVER_UNREACHABLE, { retryAfterMs });
  }

  static protocol(reason: string): SuperbotError {
    return new SuperbotError("protocol", `Unexpected Superbot response: ${reason}`);
  }

  static credentialStore(cause: unknown): SuperbotError {
    return new SuperbotError(
      "credentialStore",
      `Could not access your system credential store: ${describe(cause)}`,
      { cause },
    );
  }

  /**
   * The error a refused request reports. An RPC error body (`{ json: { status, code, message } }`)
   * may name a more specific status than the HTTP one; a gateway status means unavailable.
   */
  static server(httpStatus: number, payload: unknown): SuperbotError {
    const body = field(payload, "json") ?? payload;
    const named = field(body, "status");
    const status =
      typeof named === "number" && Number.isInteger(named) && named >= 400 && named <= 599
        ? named
        : httpStatus;
    if (status >= 502 && status <= 504) return SuperbotError.unavailable();
    const code = field(body, "code");
    const text = field(body, "message") ?? field(body, "error");
    const message = typeof text === "string" && text !== "" ? text : defaultMessage(status);
    return new SuperbotError("server", `Superbot returned HTTP ${status}: ${message}`, {
      status,
      code: typeof code === "string" ? code : undefined,
    });
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function defaultMessage(status: number): string {
  switch (status) {
    case 401:
      return "Session rejected. Sign in again.";
    case 403:
      return "Access denied.";
    case 404:
      return "The requested endpoint or chat was not found.";
    case 429:
      return "Too many requests. Try again later.";
    default:
      return "Request failed.";
  }
}

/** A cause's own words: fetch reports "fetch failed" and keeps the reason in its cause. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.cause instanceof Error && error.cause.message) return error.cause.message;
  return error.message;
}
