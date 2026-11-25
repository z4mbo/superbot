import { randomUUID } from "node:crypto";
import type { RPCLink } from "@orpc/client/fetch";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import { messageTextFits } from "@rakazo/contracts";
import { anySignal, deadlineSignal } from "@rakazo/core";
import { SuperbotError } from "../errors.js";
import type { ChatMessage, ThreadEvent, ThreadTarget } from "./messages.js";
import { assertThreadEvent, toChatMessages } from "./messages.js";
import { serverOrigin } from "./server-origin.js";
import type { CallContext } from "./transport.js";
import {
  checked,
  createRpcLink,
  IdleDeadline,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  send,
  toSuperbotError,
  USER_AGENT,
} from "./transport.js";

/**
 * Sign-in requests name the app scheme as their origin, which the server trusts for native
 * clients; a command line has no web origin of its own.
 */
const APP_ORIGIN = "rakazo://";
const SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export type Space = RpcOutput<"spaces/list">["spaces"][number];
export type Agent = RpcOutput<"bots/list">[number];
export type BotConversation = RpcOutput<"threads/createBotConversation">;
export type BotConversationPatch = Partial<
  Pick<RpcInput<"threads/updateBotConversation">, "title" | "pinned" | "archived">
>;
export type SendReceipt = RpcOutput<"threads/send">;
export type LocalHistoryReceipt = RpcOutput<"threads/appendLocalHistory">;
/** The latest history and the cursor to follow it from, loaded together. */
export type ThreadSnapshot = Pick<RpcOutput<"threads/get">, "threadId" | "cursor"> & {
  messages: ChatMessage[];
};

type NotificationType = EventOf<RpcOutput<"notifications/subscribe">>["type"];
/** Content-free hints to re-read the selected Space with its normal RPCs. */
export type SpaceNotification = Extract<
  NotificationType,
  "roster" | "runs" | "organizations" | "pluginRegistry"
>;
const SPACE_NOTIFICATIONS: ReadonlySet<string> = new Set<SpaceNotification>([
  "roster",
  "runs",
  "organizations",
  "pluginRegistry",
]);

export type SignUpResult = { kind: "signedIn"; client: Client } | { kind: "verifyEmail" };

/** The payload type of an event stream procedure's events. */
export type EventOf<Output> = Output extends AsyncIterable<infer Event> ? Event : never;

export type CallOptions = { signal?: AbortSignal };

/** A path outside the contract; a contract path must take its typed overload. */
type UnknownPath<Path extends string> = Path extends RpcPath ? never : Path;

const tokens = new WeakMap<Client, string>();

/** The signed session token a client carries, for saving it. Not part of the package's API. */
export function sessionToken(client: Client): string | undefined {
  return tokens.get(client);
}

/**
 * A connection to one Superbot server. Signing in returns a new client carrying the session;
 * clients are immutable and safe to share.
 */
export class Client {
  /** The server's origin with its trailing slash, such as `https://example.test/`. */
  readonly server: string;
  readonly #link: RPCLink<CallContext>;
  #bearer: string | undefined;

  /** Accepts an HTTPS origin, or HTTP on loopback for local Superbot deployments. */
  constructor(server: string) {
    this.server = serverOrigin(server).origin;
    this.#link = createRpcLink(this.server);
  }

  /** Attaches the signed session (`<session>.<signature>`) returned by Superbot's auth API. */
  withToken(token: string): Client {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1 || !/^[\x21-\x7e]+$/.test(token)) {
      throw SuperbotError.invalidSession();
    }
    const signed = new Client(this.server);
    signed.#bearer = `Bearer ${token}`;
    tokens.set(signed, token);
    return signed;
  }

  signIn(email: string, password: string): Promise<Client> {
    return this.#authenticate("sign-in/email", { email, password });
  }

  /** Signs in at once, or asks the person to verify their email first, as the server's policy says. */
  async signUp(name: string, email: string, password: string): Promise<SignUpResult> {
    const response = await this.#auth("sign-up/email", { name, email, password }, false);
    const token = signedToken(response);
    if (token !== undefined) {
      await response.body?.cancel();
      return { kind: "signedIn", client: this.withToken(token) };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw SuperbotError.transport(error);
    }
    if (typeof body === "object" && body !== null && "token" in body && body.token === null) {
      return { kind: "verifyEmail" };
    }
    throw SuperbotError.invalidSession();
  }

  async requestSignInCode(email: string): Promise<void> {
    const response = await this.#auth(
      "email-otp/send-verification-otp",
      { email, type: "sign-in" },
      false,
    );
    await response.body?.cancel();
  }

  signInWithCode(email: string, code: string): Promise<Client> {
    return this.#authenticate("sign-in/email-otp", { email, otp: code });
  }

  /** Revokes this client's session on the server. */
  async signOut(): Promise<void> {
    const response = await this.#auth("sign-out", {}, true);
    await response.body?.cancel();
  }

  /** The member's Spaces, including those in organizations other than the active one. */
  async listSpaces(): Promise<Space[]> {
    const navigation = await this.rpc("spaces/list", null, {});
    return this.includeOtherSpaces(null, navigation.spaces);
  }

  /** Adds the member's accessible Spaces from organizations outside the selected navigation. */
  async includeOtherSpaces(currentSpace: string | null, spaces: Space[]): Promise<Space[]> {
    let organizations: RpcOutput<"organizations/list">;
    try {
      organizations = await this.rpc("organizations/list", currentSpace, {});
    } catch (error) {
      // A server without organizations has only the Spaces already listed.
      if (error instanceof SuperbotError && error.kind === "server" && error.status === 404) {
        return spaces;
      }
      throw error;
    }
    const all = [...spaces];
    const seen = new Set(spaces.map((space) => space.id));
    const otherDefaults = organizations.organizations.filter(
      (organization) =>
        organization.id !== organizations.activeOrganizationId &&
        organization.spaceIds.includes(organization.defaultSpaceId),
    );
    for (const organization of otherDefaults) {
      const other = await this.rpc("spaces/list", organization.defaultSpaceId, {});
      for (const space of other.spaces) {
        if (seen.has(space.id)) continue;
        seen.add(space.id);
        all.push(space);
      }
    }
    return all;
  }

  listAgents(spaceId: string): Promise<Agent[]> {
    return this.rpc("bots/list", spaceId, {});
  }

  /** The latest history of a bot's chat with the cursor to follow it from. */
  async thread(spaceId: string, agentId: string): Promise<ThreadSnapshot> {
    const snapshot = await this.rpc("threads/get", spaceId, { botId: agentId });
    return {
      threadId: snapshot.threadId,
      cursor: snapshot.cursor,
      messages: toChatMessages(snapshot.messages),
    };
  }

  /** Recent messages of a bot's chat. */
  async messages(spaceId: string, agentId: string): Promise<ChatMessage[]> {
    const page = await this.rpc("threads/messages", spaceId, { botId: agentId });
    return toChatMessages(page.messages);
  }

  sendMessage(spaceId: string, agentId: string, text: string): Promise<SendReceipt> {
    return this.sendWithNonce(spaceId, agentId, text, randomUUID());
  }

  /** Reuse the same nonce and text when retrying a send with an unknown outcome. */
  async sendWithNonce(
    spaceId: string,
    agentId: string,
    text: string,
    nonce: string,
  ): Promise<SendReceipt> {
    if (text.trim() === "" || !messageTextFits(text)) throw SuperbotError.invalidMessage();
    return this.rpc("threads/send", spaceId, { botId: agentId, text, clientNonce: nonce });
  }

  listBotConversations(spaceId: string, botId: string): Promise<BotConversation[]> {
    return this.rpc("threads/listBotConversations", spaceId, { botId });
  }

  createBotConversation(spaceId: string, botId: string): Promise<BotConversation> {
    return this.rpc("threads/createBotConversation", spaceId, { botId });
  }

  updateBotConversation(
    spaceId: string,
    botId: string,
    threadId: string,
    patch: BotConversationPatch,
  ): Promise<BotConversation> {
    return this.rpc("threads/updateBotConversation", spaceId, { botId, threadId, ...patch });
  }

  /** Records a note without starting a run. Reuse the operation ID and payload on retries. */
  appendLocalNote(
    spaceId: string,
    target: ThreadTarget,
    operationId: string,
    text: string,
  ): Promise<LocalHistoryReceipt> {
    return this.rpc("threads/appendLocalHistory", spaceId, { ...target, operationId, text });
  }

  /** Records a completed local exchange atomically. Reuse the operation ID and payload on retries. */
  appendLocalTurn(
    spaceId: string,
    target: ThreadTarget,
    operationId: string,
    text: string,
    reply: string,
  ): Promise<LocalHistoryReceipt> {
    return this.rpc("threads/appendLocalHistory", spaceId, {
      ...target,
      operationId,
      text,
      reply,
    });
  }

  /**
   * Replays a bot's chat events strictly after `cursor`, then follows live ones. Reconnect with
   * the last non-heartbeat `seq` consumed; match replies and run events by `runId`.
   */
  subscribe(
    spaceId: string,
    agentId: string,
    cursor: number,
    options?: CallOptions,
  ): Promise<AsyncGenerator<ThreadEvent, void, undefined>> {
    return this.subscribeThread(spaceId, { botId: agentId }, cursor, options);
  }

  /** The same resumable stream for any chat: a bot conversation or a shared group. */
  async subscribeThread(
    spaceId: string,
    target: ThreadTarget,
    cursor: number,
    options?: CallOptions,
  ): Promise<AsyncGenerator<ThreadEvent, void, undefined>> {
    const events = await this.subscribeRpc(
      "threads/subscribe",
      spaceId,
      { ...target, cursor },
      options,
    );
    return (async function* () {
      for await (const event of events) {
        assertThreadEvent(event);
        yield event;
      }
    })();
  }

  /**
   * Follows account and Space change hints. The server sends catch-up hints on every connection;
   * chat alerts, heartbeats and kinds this client does not know are dropped.
   */
  async subscribeNotifications(
    spaceId: string,
    options?: CallOptions,
  ): Promise<AsyncGenerator<SpaceNotification, void, undefined>> {
    const events = await this.subscribeRpc("notifications/subscribe", spaceId, {}, options);
    return (async function* () {
      for await (const event of events) {
        const type: unknown = (event as { type?: unknown } | null)?.type;
        if (typeof type === "string" && SPACE_NOTIFICATIONS.has(type)) {
          yield type as SpaceNotification;
        }
      }
    })();
  }

  /**
   * Calls an authenticated oRPC procedure. `path` is relative to `/rpc/` (such as `bots/list`) and
   * `spaceId` scopes the call to a Space.
   */
  rpc<P extends RpcPath>(
    path: P,
    spaceId: string | null,
    input: RpcInput<P> | Record<string, never>,
    options?: CallOptions,
  ): Promise<RpcOutput<P>>;
  /** A procedure this build's contract does not know, such as one a newer server added. */
  rpc<Path extends string>(
    path: UnknownPath<Path>,
    spaceId: string | null,
    input: unknown,
    options?: CallOptions,
  ): Promise<unknown>;
  async rpc(
    path: string,
    spaceId: string | null,
    input: unknown,
    options?: CallOptions,
  ): Promise<unknown> {
    const segments = procedureSegments(path);
    const authorization = this.#authorization();
    const signal = deadlineSignal(REQUEST_TIMEOUT_MS, options?.signal);
    let output: unknown;
    try {
      output = await this.#link.call(segments, input, {
        context: { authorization, spaceId },
        signal,
      });
    } catch (error) {
      throw callerAbort(options) ?? toSuperbotError(error);
    }
    if (isAsyncIterator(output)) {
      await output.return?.();
      throw SuperbotError.protocol("invalid RPC response");
    }
    return output;
  }

  /**
   * Opens a Space-scoped oRPC event stream and yields each event's payload. It ends when the
   * server closes it; the caller decides whether to reconnect. Breaking out of the loop closes it.
   */
  subscribeRpc<P extends RpcPath>(
    path: P,
    spaceId: string,
    input: RpcInput<P> | Record<string, never>,
    options?: CallOptions,
  ): Promise<AsyncGenerator<EventOf<RpcOutput<P>>, void, undefined>>;
  subscribeRpc<Path extends string>(
    path: UnknownPath<Path>,
    spaceId: string,
    input: unknown,
    options?: CallOptions,
  ): Promise<AsyncGenerator<unknown, void, undefined>>;
  async subscribeRpc(
    path: string,
    spaceId: string,
    input: unknown,
    options?: CallOptions,
  ): Promise<AsyncGenerator<unknown, void, undefined>> {
    const segments = procedureSegments(path);
    const authorization = this.#authorization();
    const idle = new IdleDeadline(STREAM_IDLE_TIMEOUT_MS);
    const signal = options?.signal ? anySignal([options.signal, idle.signal]) : idle.signal;
    let output: unknown;
    try {
      output = await this.#link.call(segments, input, {
        context: { authorization, spaceId, idle },
        signal,
      });
    } catch (error) {
      idle.stop();
      throw callerAbort(options) ?? toSuperbotError(error);
    }
    if (!isAsyncIterator(output)) {
      idle.stop();
      throw SuperbotError.protocol("expected a Superbot event stream");
    }
    return streamEvents(output, idle, options);
  }

  #authorization(): string {
    if (this.#bearer === undefined) throw SuperbotError.missingSession();
    return this.#bearer;
  }

  async #authenticate(path: string, input: Record<string, string>): Promise<Client> {
    const response = await this.#auth(path, input, false);
    await response.body?.cancel();
    const token = signedToken(response);
    if (token === undefined) throw SuperbotError.invalidSession();
    return this.withToken(token);
  }

  /** Sign-in endpoints are not oRPC procedures, so they are plain JSON requests. */
  async #auth(path: string, input: unknown, authenticated: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "user-agent": USER_AGENT,
    };
    if (authenticated) headers.authorization = this.#authorization();
    const response = await send(new URL(`api/auth/${path}`, this.server), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: deadlineSignal(REQUEST_TIMEOUT_MS),
    });
    return checked(response);
  }
}

/** The signed session a sign-in answered with: the bearer header, else the session cookie. */
function signedToken(response: Response): string | undefined {
  const header = response.headers.get("set-auth-token");
  if (header !== null) return header;
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (SESSION_COOKIES.includes(pair.slice(0, equals))) return pair.slice(equals + 1);
  }
  return undefined;
}

function procedureSegments(path: string): string[] {
  const segments = path.split("/");
  if (!segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) {
    throw SuperbotError.protocol("invalid RPC procedure path");
  }
  return segments;
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { next?: unknown }).next === "function" &&
    Symbol.asyncIterator in value
  );
}

/** The caller's own cancellation surfaces as its reason, not as a failure of the server. */
function callerAbort(options: CallOptions | undefined): unknown {
  return options?.signal?.aborted ? options.signal.reason : undefined;
}

async function* streamEvents(
  events: AsyncIterator<unknown>,
  idle: IdleDeadline,
  options: CallOptions | undefined,
): AsyncGenerator<unknown, void, undefined> {
  let open = true;
  try {
    while (true) {
      let next: IteratorResult<unknown>;
      try {
        next = await events.next();
      } catch (error) {
        open = false;
        throw callerAbort(options) ?? toSuperbotError(error);
      }
      if (next.done) {
        open = false;
        return;
      }
      yield next.value;
    }
  } finally {
    idle.stop();
    if (open) await events.return?.();
  }
}
