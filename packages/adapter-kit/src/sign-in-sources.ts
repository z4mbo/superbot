import type { AdapterContext, AdapterDescriptor } from "./types.js";

/**
 * What the provider gave back for one person's connection, opaque to everything but the provider.
 * Core seals it in the secret store and hands it back unchanged.
 */
export interface SignInSourceCredential {
  secret: string;
  /** When the provider wants `refresh` called; null when it never expires on its own. */
  refreshAt: Date | null;
}

export interface SignInSourceConnectStart {
  /** The provider's page where the person signs in and approves the connection. */
  authorizeUrl: string;
  /** What `finishConnect` needs to check the callback, such as a PKCE verifier; core seals it. */
  pending: string;
  /** The `state` the callback must echo; core binds it to the person's pending connection. */
  state: string;
  expiresAt: Date;
}

/** The parameters the provider sent back to the redirect page, exactly as they arrived. */
export interface SignInSourceCallback {
  code: string;
  state: string;
  /** Material some providers return only in the redirect page's fragment, on first consent. */
  fragment?: Readonly<Record<string, string>>;
}

export type SignInAccessState =
  | { state: "pending" }
  /** The person approved a login for the site; `reference` names it and is never a secret value. */
  | { state: "approved"; reference: string }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "failed" };

export interface SignInAccessRequest {
  /** The provider's id for the request, used to check on it. */
  id: string;
  /** The provider's id for the one login entry asked for; grants are matched to it. */
  entryId: string;
  /**
   * The link that opens the approval prompt in the provider's app, exactly as the provider
   * returned it. Never parsed, rebuilt or shown to the model.
   */
  approvalLink: string;
}

/**
 * What the agent's browser needs to fill one granted login: the provider's own call, built by the
 * provider. It may carry the connection's tokens, so it lives only in memory for the one fill.
 */
export interface SignInFillCall {
  method: string;
  params: Readonly<Record<string, unknown>>;
}

export type SignInFillOutcome =
  | { status: "submitted" }
  /** The login's approval is gone (it expired or was revoked): ask the person again. */
  | { status: "no_active_grant" }
  /** The connection itself no longer works: the person connects again. */
  | { status: "disconnected" }
  | { status: "failed" };

export interface SignInSourceCapabilities {
  /** Runs without the network; only the emulator. */
  offline: boolean;
  /** The server has what the provider needs to connect (such as a client registration). */
  connectable: boolean;
  /** How long one approval lasts before the person is asked again, in days. */
  grantDays: number;
  /** The schemes an approval link may use, as the provider documents them, such as "app:". */
  approvalLinkSchemes: readonly string[];
}

/**
 * A password manager the person connects once, which lets a bot sign in to a website after the
 * person approves each login in the password manager's own app. Core never receives a username,
 * password or one-time code: the agent's browser fills the granted login through the provider's
 * fill call, and the bot only learns whether it signed in.
 */
export interface SignInSourceProvider {
  describe(): AdapterDescriptor<SignInSourceCapabilities>;
  /** Product name shown on the connect entry and the review button. */
  readonly displayName: string;
  beginConnect(
    request: { redirectUri: string },
    context: AdapterContext,
  ): Promise<SignInSourceConnectStart>;
  /**
   * Finish the connection from the redirect. `previous` is the connection being replaced, for
   * providers that send some material only on first consent.
   */
  finishConnect(
    request: {
      pending: string;
      redirectUri: string;
      callback: SignInSourceCallback;
      previous?: SignInSourceCredential;
    },
    context: AdapterContext,
  ): Promise<SignInSourceCredential>;
  refresh(
    credential: SignInSourceCredential,
    context: AdapterContext,
  ): Promise<SignInSourceCredential>;
  /** Revoke the connection with the provider; throws when it could not, so core keeps it. */
  disconnect(credential: SignInSourceCredential, context: AdapterContext): Promise<void>;
  /** Ask the person to approve a login for `site` in the provider's app. Never pre-approved. */
  requestAccess(
    credential: SignInSourceCredential,
    request: { site: string; goal: string },
    context: AdapterContext,
  ): Promise<SignInAccessRequest>;
  accessState(
    credential: SignInSourceCredential,
    request: { id: string; entryId: string },
    context: AdapterContext,
  ): Promise<SignInAccessState>;
  /** The call the agent's browser makes to fill and submit the granted login in its tab. */
  fillCall(credential: SignInSourceCredential, reference: string): SignInFillCall;
  /** What the browser's answer to `fillCall` means. */
  fillOutcome(result: unknown): SignInFillOutcome;
}

/**
 * The agent browser's side of a fill: make the provider's call in the tab on `origin`, where the
 * provider's extension fills and submits the login. Implemented by a browser that runs it.
 */
export interface SignInFillPort {
  fill(
    request: { origin: string; call: SignInFillCall },
    context: AdapterContext,
  ): Promise<unknown>;
}

/** The provider no longer accepts the connection; the person has to connect again. */
export class SignInSourceDisconnected extends Error {
  constructor() {
    super("The sign-in connection was revoked or expired.");
    this.name = "SignInSourceDisconnected";
  }
}
