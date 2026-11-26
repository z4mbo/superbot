import type {
  AdapterContext,
  SignInAccessState,
  SignInFillPort,
  SignInSourceProvider,
} from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";
import type { SignInBlock } from "@rakazo/contracts";
import { abortableDelay, ClientError, pollUntil } from "@rakazo/core";
import type { SignInRequest } from "@rakazo/db";
import {
  SIGN_IN_DENIED,
  SIGN_IN_EXPIRED,
  SIGN_IN_FILL_FAILED,
  SIGN_IN_FILL_UNAVAILABLE,
  SIGN_IN_FILLED,
  SIGN_IN_GOAL,
  SIGN_IN_NEEDS_RECONNECT,
  SIGN_IN_NOT_CONNECTED,
  SIGN_IN_NOT_HTTPS,
  SIGN_IN_NOT_REVIEWED,
  SIGN_IN_PROVIDER_FAILED,
  SIGN_IN_STILL_PENDING,
  SIGN_IN_USE_VAULT_LOGIN,
} from "./sign-in.prompt.js";
import type { SignInAuditAction } from "./sign-in-source-activity.js";
import { recordSignInEvent } from "./sign-in-source-activity.js";
import type { SignInActor, SignInSourceDeps } from "./sign-in-source-connections.js";
import {
  providerContext,
  signInSourceConnected,
  warnSignIn,
  withSignInCredential,
} from "./sign-in-source-connections.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * How long the call waits for the person to open the review, and then how it checks for the
 * answer: the provider asks for no checks in the first 5 seconds after the link opens, then every
 * 2 seconds until 30 seconds, every 5 until a minute, every 10 until two, every 20 until three,
 * and then to stop and ask the person.
 */
export interface SignInTiming {
  openWaitMs: number;
  firstCheckMs: number;
  checkEveryMs: (elapsedMs: number) => number;
  checkForMs: number;
}

export const SIGN_IN_TIMING: SignInTiming = {
  openWaitMs: 10 * 60_000,
  firstCheckMs: 5_000,
  checkEveryMs: (elapsed) =>
    elapsed < 30_000 ? 2_000 : elapsed < 60_000 ? 5_000 : elapsed < 120_000 ? 10_000 : 20_000,
  checkForMs: 3 * 60_000,
};

/** What a run gives the sign_in tool: the person, the chat, and the browser that fills. */
export interface SignInRun {
  deps: SignInSourceDeps & { signInSource: SignInSourceProvider };
  actor: SignInActor;
  bot: { id: string; name: string };
  runId: string;
  threadId: string;
  context: AdapterContext;
  /** The name of a saved vault login this bot may use on `origin`, if any. */
  vaultLoginFor(origin: string): Promise<string | undefined>;
  /** Post the card in the chat; null when the run can no longer post. */
  postCard(block: SignInBlock): Promise<{ messageId: string } | null>;
  /** Change the card the run posted; the chat redraws it. */
  updateCard(messageId: string, change: (block: SignInBlock) => SignInBlock): Promise<void>;
  /** Resolves true once the person opened the card's review, false when `signal` ends first. */
  waitForOpen(messageId: string, signal: AbortSignal): Promise<boolean>;
  /** The agent browser's fill, absent when it has no sign-in extension. */
  fill: SignInFillPort | undefined;
  timing?: SignInTiming;
}

/** The request is no longer the person's to review. */
export class SignInRequestClosedError extends ClientError {
  constructor() {
    super("CONFLICT", "This sign-in request is closed.", "SIGN_IN_REQUEST_CLOSED");
    this.name = "SignInRequestClosedError";
  }
}

export function signInOrigin(site: unknown): string | undefined {
  if (typeof site !== "string" || !URL.canParse(site)) return undefined;
  const url = new URL(site);
  return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
}

function audit(run: SignInRun, action: SignInAuditAction, request: SignInRequest, failed = false) {
  return recordSignInEvent({
    action,
    actor: { type: "bot", id: run.bot.id, label: run.bot.name },
    userId: run.actor.userId,
    spaceId: run.actor.spaceId,
    provider: request.provider,
    site: request.site,
    requestId: request.id,
    runId: run.runId,
    threadId: run.threadId,
    ...(failed && { outcome: "failure" as const }),
  });
}

/**
 * Sign in to `site` with a login from the person's sign-in source. A saved vault login the bot may
 * use wins; otherwise a login the person approved in the last `grantDays` is filled again;
 * otherwise the person is asked to approve one in the provider's app, from a card in the chat.
 * Only the provider's answer approves a login: nothing the bot sends can. The result never
 * carries a username, password or code, which this server never receives.
 */
export async function signIn(run: SignInRun, input: { site: unknown }): Promise<string> {
  const origin = signInOrigin(input.site);
  if (!origin) return SIGN_IN_NOT_HTTPS;
  const provider = run.deps.signInSource;
  const label = provider.displayName;
  const vaultLogin = await run.vaultLoginFor(origin);
  if (vaultLogin) return SIGN_IN_USE_VAULT_LOGIN(vaultLogin);
  const connectCard = async (text: string) => {
    await run.postCard({ kind: "sign_in", site: origin, label, status: "needs_connection" });
    return text;
  };
  if (!(await signInSourceConnected(run.deps, run.actor.userId)))
    return connectCard(SIGN_IN_NOT_CONNECTED(label));
  if (!run.fill) return SIGN_IN_FILL_UNAVAILABLE(label);
  try {
    // A remembered grant first; one the provider says is gone is asked for again, once.
    const granted = await rememberedGrant(run, origin);
    if (granted) {
      const filled = await fillGrant(run, granted);
      if (filled !== "no_active_grant") return filled;
    }
    const request = await openRequest(run, origin);
    if (typeof request === "string") return request;
    const answered = await awaitAnswer(run, request);
    if (typeof answered === "string") return answered;
    const filled = await fillGrant(run, answered);
    return filled === "no_active_grant" ? SIGN_IN_EXPIRED(label) : filled;
  } catch (error) {
    if (error instanceof SignInSourceDisconnected)
      return connectCard(SIGN_IN_NEEDS_RECONNECT(label));
    throw error;
  }
}

function rememberedGrant(run: SignInRun, origin: string): Promise<SignInRequest | null> {
  return run.deps.prisma.signInRequest.findFirst({
    where: {
      userId: run.actor.userId,
      provider: run.deps.signInSource.describe().id,
      site: origin,
      status: "approved",
      reference: { not: null },
      grantExpiresAt: { gt: new Date() },
    },
    orderBy: { resolvedAt: "desc" },
  });
}

/** This chat's open request for the site, or a new one with its card. */
async function openRequest(run: SignInRun, origin: string): Promise<SignInRequest | string> {
  const provider = run.deps.signInSource;
  const existing = await run.deps.prisma.signInRequest.findFirst({
    where: {
      userId: run.actor.userId,
      provider: provider.describe().id,
      site: origin,
      threadId: run.threadId,
      status: "pending",
      messageId: { not: null },
      createdAt: { gt: new Date(Date.now() - (run.timing ?? SIGN_IN_TIMING).openWaitMs) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;
  const created = await withSignInCredential(run.deps, run.actor, (credential) =>
    provider.requestAccess(
      credential,
      { site: origin, goal: SIGN_IN_GOAL(origin) },
      providerContext(run.actor, "request"),
    ),
  );
  // The link is kept only if it uses a scheme the provider documents; it is never parsed further.
  const schemes = provider.describe().capabilities.approvalLinkSchemes;
  if (!schemes.some((scheme) => created.approvalLink.startsWith(scheme)))
    return SIGN_IN_PROVIDER_FAILED(provider.displayName);
  const request = await run.deps.prisma.signInRequest.create({
    data: {
      userId: run.actor.userId,
      spaceId: run.actor.spaceId,
      botId: run.bot.id,
      threadId: run.threadId,
      runId: run.runId,
      provider: provider.describe().id,
      site: origin,
      remoteId: created.id,
      entryId: created.entryId,
      approvalLink: created.approvalLink,
      status: "pending",
    },
  });
  const card = await run.postCard({
    kind: "sign_in",
    site: origin,
    label: provider.displayName,
    status: "pending",
    requestId: request.id,
  });
  await audit(run, "sign_in.requested", request);
  if (!card) return SIGN_IN_NOT_REVIEWED(provider.displayName);
  return run.deps.prisma.signInRequest.update({
    where: { id: request.id },
    data: { messageId: card.messageId },
  });
}

const CLOSED: Record<Exclude<SignInAccessState["state"], "pending" | "approved">, string> = {
  denied: "denied",
  expired: "expired",
  failed: "failed",
};

/** Settle the request and its card; only the provider's answer reaches here. */
async function settle(
  run: SignInRun,
  request: SignInRequest,
  answer: Exclude<SignInAccessState, { state: "pending" }>,
): Promise<SignInRequest> {
  const resolvedAt = new Date();
  const grantDays = run.deps.signInSource.describe().capabilities.grantDays;
  const approved = answer.state === "approved";
  const status = approved ? "approved" : CLOSED[answer.state];
  const { count } = await run.deps.prisma.signInRequest.updateMany({
    where: { id: request.id, status: "pending" },
    data: {
      status,
      resolvedAt,
      ...(approved && {
        reference: answer.reference,
        grantExpiresAt: new Date(resolvedAt.getTime() + grantDays * DAY_MS),
      }),
    },
  });
  const settled = await run.deps.prisma.signInRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  if (!count) return settled;
  if (settled.messageId)
    await run.updateCard(settled.messageId, (block) => ({
      ...block,
      status: settled.status as SignInBlock["status"],
    }));
  await audit(
    run,
    approved
      ? "sign_in.approved"
      : answer.state === "denied"
        ? "sign_in.denied"
        : "sign_in.expired",
    settled,
    answer.state === "failed",
  );
  return settled;
}

/** Wait for the person to open the review, then ask the provider for their answer. */
async function awaitAnswer(
  run: SignInRun,
  request: SignInRequest,
): Promise<SignInRequest | string> {
  const provider = run.deps.signInSource;
  const label = provider.displayName;
  const timing = run.timing ?? SIGN_IN_TIMING;
  if (!request.openedAt) {
    const wait = AbortSignal.any([AbortSignal.timeout(timing.openWaitMs), run.context.signal]);
    const opened = request.messageId ? await run.waitForOpen(request.messageId, wait) : false;
    run.context.signal.throwIfAborted();
    if (!opened) {
      await settle(run, request, { state: "expired" });
      return SIGN_IN_NOT_REVIEWED(label);
    }
    await abortableDelay(timing.firstCheckMs, run.context.signal);
  }
  const started = Date.now();
  const answer = await pollUntil(
    async () => {
      const state = await withSignInCredential(run.deps, run.actor, (credential) =>
        provider.accessState(
          credential,
          { id: request.remoteId, entryId: request.entryId },
          providerContext(run.actor, "status"),
        ),
      ).catch((error: unknown) => {
        if (error instanceof SignInSourceDisconnected) throw error;
        // A failed check is retried on the schedule; the next one may get through.
        warnSignIn("Sign-in request check failed", error);
        return { state: "pending" } as const;
      });
      return state.state === "pending" ? undefined : state;
    },
    {
      intervalMs: () => timing.checkEveryMs(Date.now() - started),
      timeoutMs: timing.checkForMs,
      signal: run.context.signal,
      onTimeout: () => undefined,
    },
  );
  run.context.signal.throwIfAborted();
  if (!answer) return SIGN_IN_STILL_PENDING(label);
  const settled = await settle(run, request, answer);
  if (settled.status === "approved" && settled.reference) return settled;
  if (settled.status === "denied") return SIGN_IN_DENIED(label);
  if (settled.status === "failed") return SIGN_IN_PROVIDER_FAILED(label);
  return SIGN_IN_EXPIRED(label);
}

/**
 * Fill the granted login in the agent's browser. The provider builds its own fill call from the
 * grant reference, and the browser's extension types the login, so the values never pass here.
 */
async function fillGrant(
  run: SignInRun,
  request: SignInRequest,
): Promise<string | "no_active_grant"> {
  const provider = run.deps.signInSource;
  const label = provider.displayName;
  const fill = run.fill;
  if (!fill || !request.reference) return SIGN_IN_FILL_UNAVAILABLE(label);
  const reference = request.reference;
  const outcome = await withSignInCredential(run.deps, run.actor, async (credential) => {
    let result: unknown;
    try {
      result = await fill.fill(
        { origin: request.site, call: provider.fillCall(credential, reference) },
        run.context,
      );
    } catch (error) {
      warnSignIn("Sign-in fill failed", error);
      return { status: "failed" } as const;
    }
    const read = provider.fillOutcome(result);
    if (read.status === "disconnected") throw new SignInSourceDisconnected();
    return read;
  });
  if (outcome.status === "submitted") {
    await audit(run, "sign_in.filled", request);
    return SIGN_IN_FILLED;
  }
  await audit(run, "sign_in.fill_failed", request, true);
  if (outcome.status === "no_active_grant") {
    // The approval ran out or was revoked: it is not used again, and the person is asked anew.
    await run.deps.prisma.signInRequest.updateMany({
      where: { id: request.id },
      data: { grantExpiresAt: new Date() },
    });
    return "no_active_grant";
  }
  return SIGN_IN_FILL_FAILED(label);
}

/**
 * The approval link of one of the person's own pending requests, exactly as the provider returned
 * it, for the card's review button. Reading it marks the request opened, which is when the waiting
 * call starts asking the provider for the answer. Nothing here can approve the request.
 */
export async function reviewSignInRequest(
  deps: Pick<SignInSourceDeps, "prisma" | "signInSource">,
  actor: SignInActor,
  requestId: string,
  markOpened: (request: SignInRequest) => Promise<void>,
): Promise<{ approvalLink: string }> {
  const request = await deps.prisma.signInRequest.findFirst({
    where: { id: requestId, userId: actor.userId, spaceId: actor.spaceId },
  });
  if (
    !request ||
    request.status !== "pending" ||
    request.provider !== deps.signInSource?.describe().id
  )
    throw new SignInRequestClosedError();
  if (!request.openedAt) {
    await deps.prisma.signInRequest.updateMany({
      where: { id: request.id, openedAt: null },
      data: { openedAt: new Date() },
    });
    await markOpened(request);
  }
  return { approvalLink: request.approvalLink };
}
