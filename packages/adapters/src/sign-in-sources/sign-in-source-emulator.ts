import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AdapterDescriptor,
  SignInAccessRequest,
  SignInAccessState,
  SignInFillCall,
  SignInFillOutcome,
  SignInSourceCallback,
  SignInSourceCapabilities,
  SignInSourceConnectStart,
  SignInSourceCredential,
  SignInSourceProvider,
} from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";

/** The emulator's fill call, which only the emulator's own fill extension answers. */
export const EMULATOR_FILL_METHOD = "emulator.fillGranted";
const TOKEN_PREFIX = "emulator-token:";

/**
 * Deterministic offline sign-in source. Connecting sends the person straight back to the redirect
 * page. A request is approved the first time it is checked, except on sites whose host starts
 * with `deny.` (denied) or `expire.` (expired), so callers can drive every outcome. State lives in
 * the ids and tokens, so an API and a worker process agree without sharing memory; only
 * revocation is per process.
 */
export class EmulatorSignInSourceProvider implements SignInSourceProvider {
  readonly displayName = "Emulator Passwords";
  private readonly revoked = new Set<string>();

  describe(): AdapterDescriptor<SignInSourceCapabilities> {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        offline: true,
        connectable: true,
        grantDays: 30,
        approvalLinkSchemes: ["https:"],
      },
    };
  }

  async beginConnect(
    request: { redirectUri: string },
    context: AdapterContext,
  ): Promise<SignInSourceConnectStart> {
    context.signal.throwIfAborted();
    const state = randomUUID();
    const code = `emulator-code:${randomUUID()}`;
    const back = new URL(request.redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    back.hash = `key=${encodeURIComponent(`emulator-key:${state}`)}`;
    return {
      authorizeUrl: back.toString(),
      pending: code,
      state,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  async finishConnect(
    request: {
      pending: string;
      redirectUri: string;
      callback: SignInSourceCallback;
      previous?: SignInSourceCredential;
    },
    context: AdapterContext,
  ): Promise<SignInSourceCredential> {
    context.signal.throwIfAborted();
    if (request.callback.code !== request.pending) throw new Error("Unknown sign-in code");
    const key = request.callback.fragment?.key ?? keyOf(request.previous);
    if (!key) throw new Error("The connection has no key");
    return { secret: this.token(key), refreshAt: null };
  }

  async refresh(
    credential: SignInSourceCredential,
    context: AdapterContext,
  ): Promise<SignInSourceCredential> {
    context.signal.throwIfAborted();
    this.check(credential);
    return { secret: credential.secret, refreshAt: null };
  }

  async disconnect(credential: SignInSourceCredential, context: AdapterContext): Promise<void> {
    context.signal.throwIfAborted();
    this.revoked.add(credential.secret);
  }

  async requestAccess(
    credential: SignInSourceCredential,
    request: { site: string; goal: string },
    context: AdapterContext,
  ): Promise<SignInAccessRequest> {
    context.signal.throwIfAborted();
    this.check(credential);
    const host = new URL(request.site).host;
    const id = `${host}~${randomUUID()}`;
    return {
      id,
      entryId: `entry-${id}`,
      approvalLink: `https://sign-in.emulator.invalid/approve/${encodeURIComponent(id)}`,
    };
  }

  async accessState(
    credential: SignInSourceCredential,
    request: { id: string; entryId: string },
    context: AdapterContext,
  ): Promise<SignInAccessState> {
    context.signal.throwIfAborted();
    this.check(credential);
    const host = request.id.split("~")[0] ?? "";
    if (host.startsWith("deny.")) return { state: "denied" };
    if (host.startsWith("expire.")) return { state: "expired" };
    return { state: "approved", reference: `emulator-grant/${request.id}` };
  }

  fillCall(credential: SignInSourceCredential, reference: string): SignInFillCall {
    return { method: EMULATOR_FILL_METHOD, params: { token: credential.secret, reference } };
  }

  fillOutcome(result: unknown): SignInFillOutcome {
    const status = (result as { status?: unknown } | null)?.status;
    if (status === "submitted") return { status: "submitted" };
    if (status === "no_active_grant") return { status: "no_active_grant" };
    if (status === "disconnected") return { status: "disconnected" };
    return { status: "failed" };
  }

  private token(key: string): string {
    return `${TOKEN_PREFIX}${key}`;
  }

  private check(credential: SignInSourceCredential): void {
    if (!credential.secret.startsWith(TOKEN_PREFIX) || this.revoked.has(credential.secret))
      throw new SignInSourceDisconnected();
  }
}

function keyOf(previous: SignInSourceCredential | undefined): string | undefined {
  return previous?.secret.startsWith(TOKEN_PREFIX)
    ? previous.secret.slice(TOKEN_PREFIX.length)
    : undefined;
}
