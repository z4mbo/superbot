import { ErrorEvent, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { parseRetryAfter } from "@rakazo/core";
import { SuperbotError } from "../errors.js";

export const REQUEST_TIMEOUT_MS = 30_000;
/** Longer than the server's heartbeat, so only a stream that went quiet ends. */
export const STREAM_IDLE_TIMEOUT_MS = 65_000;
export const USER_AGENT = "superbot-client";
/**
 * The scope header keeps its pre-Superbot name: servers and clients of either name must keep
 * understanding each other.
 */
export const SPACE_HEADER = "x-rakazo-space-id";

export type CallContext = {
  authorization: string;
  spaceId?: string | null;
  /** Set on event streams, which end when no bytes arrive in time. */
  idle?: IdleDeadline;
};

/** The typed oRPC link for one server: the web app's protocol, signed with the bearer session. */
export function createRpcLink(server: string): RPCLink<CallContext> {
  return new RPCLink<CallContext>({
    url: new URL("rpc", server).href,
    headers: ({ context }) => {
      const headers: Record<string, string> = {
        authorization: context.authorization,
        "user-agent": USER_AGENT,
      };
      if (context.spaceId) headers[SPACE_HEADER] = context.spaceId;
      if (context.idle) headers.accept = "text/event-stream";
      return headers;
    },
    fetch: async (request, init, { context }) => {
      const response = await send(request, init);
      return context.idle ? checked(response, context.idle) : checked(response);
    },
  });
}

/** One HTTP exchange; a request that got no answer is a transport failure. Redirects are not followed. */
export async function send(input: Request | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, { ...init, redirect: "manual" });
  } catch (error) {
    throw SuperbotError.transport(error);
  }
}

/**
 * The response when it succeeded. A gateway status means the server is unavailable, honoring its
 * Retry-After; any other status (a redirect included) is the server's refusal.
 */
export async function checked(response: Response, idle?: IdleDeadline): Promise<Response> {
  if (response.status >= 200 && response.status < 300) {
    return idle ? watchBody(response, idle) : response;
  }
  idle?.stop();
  if (response.status >= 502 && response.status <= 504) {
    await response.body?.cancel();
    throw SuperbotError.unavailable(parseRetryAfter(response.headers.get("retry-after")));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // An empty or non-JSON refusal still reports its status.
    payload = undefined;
  }
  throw SuperbotError.server(response.status, payload);
}

/** Converts what a call threw into the client's error taxonomy. */
export function toSuperbotError(error: unknown): SuperbotError {
  if (error instanceof SuperbotError) return error;
  if (error instanceof ORPCError) {
    return SuperbotError.server(error.status, { code: error.code, message: error.message });
  }
  if (error instanceof ErrorEvent) return SuperbotError.server(500, error.data);
  if (interrupted(error)) return SuperbotError.transport(error);
  return SuperbotError.protocol("invalid RPC response");
}

/** The request or its body never completed: the network failed, or a deadline passed. */
function interrupted(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (
      cause instanceof TypeError ||
      cause.name === "AbortError" ||
      cause.name === "TimeoutError"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Ends an event stream that receives no bytes for `ms`: waiting for the response counts, and each
 * chunk restarts the clock.
 */
export class IdleDeadline {
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;

  constructor(ms: number) {
    this.#timer = setTimeout(() => {
      this.#controller.abort(new DOMException("The event stream went quiet", "TimeoutError"));
    }, ms);
    this.#timer.unref();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  touch(): void {
    this.#timer.refresh();
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

function watchBody(response: Response, idle: IdleDeadline): Response {
  if (!response.body) {
    idle.stop();
    return response;
  }
  idle.touch();
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        idle.touch();
        controller.enqueue(chunk);
      },
      flush() {
        idle.stop();
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
