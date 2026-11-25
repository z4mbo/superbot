import { createHash, randomBytes } from "node:crypto";
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

// 1Password for Agents (partner preview): https://www.1password.dev/agentic-autofill/partners
// Connect is OAuth 2.0 with PKCE; the first consent also returns an integration key in the
// redirect's fragment. Access requests go through the SDK's credential broker, and the fill runs
// in the agent's browser through the 1Password extension, so no username, password or one-time
// code ever reaches this server. `logins.read` is deliberately not part of this provider.
const WEB_ORIGIN = "https://my.1password.com";
const API_ORIGIN = "https://api.1password.com";
const SCOPE = "brokered-credentials:request-access brokered-credentials:read";
const CONNECT_WINDOW_MS = 15 * 60_000;
/** The docs cap a request's goal at 140 characters and an entry's reason at 100. */
const GOAL_MAX = 140;
/** The fill call the extension's service worker exposes (`api.agenticAutofill.v1.fillCredential`). */
const FILL_METHOD = "agenticAutofill.v1.fillCredential";
/** The SDK, pinned to the developer preview this provider was written against. */
export const SDK_PACKAGE = "@1password/sdk";
export const SDK_VERSION = "0.0.0-credential-broker-dev-preview.4";

/**
 * The part of the SDK's OAuth client this provider uses, matching its type definitions
 * (`createOAuthClient`, `credentialBroker.accessRequests.create` and `getStatus`). The SDK also
 * offers `credentialBroker.logins.read`, which returns the login's values; it is left out on
 * purpose, so this provider cannot read a password even by mistake.
 */
export interface CredentialBrokerSdk {
  createOAuthClient(config: { accessToken: string; integrationKey: string }): Promise<{
    credentialBroker: {
      accessRequests: {
        create(params: {
          goal?: string;
          entries: Array<{ type: "login"; parameters: { website: string }; reason?: string }>;
        }): Promise<{
          accessRequest: { id: string; entries: Array<{ id: string }> };
          appLink: string;
        }>;
        getStatus(accessRequestId: string): Promise<{
          state: string;
          resolved: Array<{ entryId?: string; reference: string }>;
        }>;
      };
    };
  }>;
}

/**
 * The SDK is an optional, unbundled dependency: it is a developer preview with no compatibility
 * guarantees and a large WebAssembly core, so a deployment that turns this provider on installs
 * `@1password/sdk@0.0.0-credential-broker-dev-preview.4` itself. Loaded on first use only.
 */
async function importSdk(): Promise<CredentialBrokerSdk> {
  const specifier: string = SDK_PACKAGE;
  try {
    return (await import(/* @vite-ignore */ specifier)) as CredentialBrokerSdk;
  } catch {
    throw new Error(`Install ${SDK_PACKAGE}@${SDK_VERSION} to use this sign-in source`);
  }
}

type Tokens = { accessToken: string; refreshToken: string; integrationKey: string };

function readTokens(credential: SignInSourceCredential): Tokens {
  try {
    const value = JSON.parse(credential.secret) as Partial<Tokens>;
    if (value.accessToken && value.refreshToken && value.integrationKey) return value as Tokens;
  } catch {
    // Unreadable material is a connection to make again.
  }
  throw new SignInSourceDisconnected();
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Errors the SDK and extension raise when the connection itself no longer works. */
const DISCONNECTED_ERRORS = new Set([
  "InvalidTokenError",
  "IntegrationKeyInvalidError",
  "AuthExpiredError",
  "FeatureEntitlementMissingError",
]);
const DISCONNECTED_FILL_CODES = new Set([
  "invalidToken",
  "integrationKeyInvalid",
  "insufficientScope",
  "featureEntitlementMissing",
]);

export class OnePasswordSignInSource implements SignInSourceProvider {
  readonly displayName = "1Password";
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly fetch: typeof fetch;
  private readonly loadSdk: () => Promise<CredentialBrokerSdk>;

  constructor(
    options: {
      clientId?: string;
      clientSecret?: string;
      fetch?: typeof fetch;
      loadSdk?: () => Promise<CredentialBrokerSdk>;
    } = {},
  ) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetch = options.fetch ?? fetch;
    this.loadSdk = options.loadSdk ?? importSdk;
  }

  describe(): AdapterDescriptor<SignInSourceCapabilities> {
    return {
      id: "onepassword",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        offline: false,
        connectable: Boolean(this.clientId && this.clientSecret),
        grantDays: 30,
        approvalLinkSchemes: ["onepassword:"],
      },
    };
  }

  async beginConnect(
    request: { redirectUri: string },
    context: AdapterContext,
  ): Promise<SignInSourceConnectStart> {
    context.signal.throwIfAborted();
    const clientId = this.requireClient().clientId;
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(24));
    const url = new URL("/oauth/authorize", WEB_ORIGIN);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: request.redirectUri,
      scope: SCOPE,
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return {
      authorizeUrl: url.toString(),
      pending: verifier,
      state,
      expiresAt: new Date(Date.now() + CONNECT_WINDOW_MS),
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
    // The key comes only on first consent; a reconnect keeps the one already stored.
    const integrationKey =
      request.callback.fragment?.integration_key ?? previousKey(request.previous);
    if (!integrationKey) throw new Error("The connection returned no integration key");
    const tokens = await this.token(
      {
        grant_type: "authorization_code",
        code: request.callback.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.pending,
      },
      context,
    );
    return this.credential({ ...tokens, integrationKey }, tokens.expiresIn);
  }

  async refresh(
    credential: SignInSourceCredential,
    context: AdapterContext,
  ): Promise<SignInSourceCredential> {
    const current = readTokens(credential);
    const tokens = await this.token(
      { grant_type: "refresh_token", refresh_token: current.refreshToken, scope: SCOPE },
      context,
    );
    return this.credential(
      { ...tokens, integrationKey: current.integrationKey },
      tokens.expiresIn,
    );
  }

  async disconnect(credential: SignInSourceCredential, context: AdapterContext): Promise<void> {
    const { accessToken } = readTokens(credential);
    const response = await this.fetch(
      new URL("/v1alpha1/oauth-integrations/self:revoke", API_ORIGIN),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
        signal: context.signal,
      },
    );
    if (!response.ok) throw new Error(`Revoke failed with HTTP ${response.status}`);
  }

  async requestAccess(
    credential: SignInSourceCredential,
    request: { site: string; goal: string },
    context: AdapterContext,
  ): Promise<SignInAccessRequest> {
    context.signal.throwIfAborted();
    const broker = await this.broker(credential);
    const created = await sdkCall(() =>
      broker.create({
        goal: request.goal.slice(0, GOAL_MAX),
        entries: [{ type: "login", parameters: { website: request.site } }],
      }),
    );
    const entryId = created.accessRequest.entries[0]?.id;
    if (!entryId) throw new Error("The access request has no entry");
    // Kept exactly as returned: the link's format is the provider's to change.
    return { id: created.accessRequest.id, entryId, approvalLink: created.appLink };
  }

  async accessState(
    credential: SignInSourceCredential,
    request: { id: string; entryId: string },
    context: AdapterContext,
  ): Promise<SignInAccessState> {
    context.signal.throwIfAborted();
    const broker = await this.broker(credential);
    const status = await sdkCall(() => broker.getStatus(request.id));
    if (status.state === "pending") return { state: "pending" };
    if (status.state === "denied") return { state: "denied" };
    if (status.state === "expired") return { state: "expired" };
    if (status.state !== "resolved") return { state: "failed" };
    // Grants match entries by id, never by position; the person may grant nothing for ours.
    const granted = status.resolved.find((entry) => entry.entryId === request.entryId);
    return granted ? { state: "approved", reference: granted.reference } : { state: "denied" };
  }

  fillCall(credential: SignInSourceCredential, reference: string): SignInFillCall {
    const { accessToken, integrationKey } = readTokens(credential);
    // The reference goes in unchanged as `resourcePath`; the browser adds its own tab id.
    return { method: FILL_METHOD, params: { accessToken, integrationKey, resourcePath: reference } };
  }

  fillOutcome(result: unknown): SignInFillOutcome {
    const answer = result as {
      success?: unknown;
      result?: { status?: unknown };
      error?: { code?: unknown };
    } | null;
    if (answer?.success === true && answer.result?.status === "fill_submitted")
      return { status: "submitted" };
    const code = typeof answer?.error?.code === "string" ? answer.error.code : "";
    if (code === "noActiveGrant" || code === "credentialNotFound")
      return { status: "no_active_grant" };
    if (DISCONNECTED_FILL_CODES.has(code)) return { status: "disconnected" };
    return { status: "failed" };
  }

  private requireClient(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret)
      throw new Error("No OAuth client is registered for this sign-in source");
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private credential(tokens: Tokens, expiresIn: number): SignInSourceCredential {
    const { accessToken, refreshToken, integrationKey } = tokens;
    return {
      secret: JSON.stringify({ accessToken, refreshToken, integrationKey }),
      refreshAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  private async token(
    form: Record<string, string>,
    context: AdapterContext,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { clientId, clientSecret } = this.requireClient();
    // Client credentials go only in the Basic header: the endpoint rejects them in the body too.
    const response = await this.fetch(new URL("/v1/oauth/token", API_ORIGIN), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: context.signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      if (body.error === "invalid_grant") throw new SignInSourceDisconnected();
      throw new Error(`Token request failed with HTTP ${response.status}`);
    }
    const { access_token, refresh_token, expires_in } = body;
    if (typeof access_token !== "string" || typeof refresh_token !== "string")
      throw new Error("Token response is missing its tokens");
    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: typeof expires_in === "number" && expires_in > 0 ? expires_in : 900,
    };
  }

  private async broker(credential: SignInSourceCredential) {
    const { accessToken, integrationKey } = readTokens(credential);
    const sdk = await this.loadSdk();
    const client = await sdkCall(() => sdk.createOAuthClient({ accessToken, integrationKey }));
    return client.credentialBroker.accessRequests;
  }
}

function previousKey(previous: SignInSourceCredential | undefined): string | undefined {
  if (!previous) return undefined;
  try {
    return readTokens(previous).integrationKey;
  } catch {
    return undefined;
  }
}

/**
 * SDK errors that mean the connection is gone become SignInSourceDisconnected. The SDK's error
 * classes leave `name` as "Error", so they are told apart by their class.
 */
async function sdkCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && DISCONNECTED_ERRORS.has(error.constructor.name))
      throw new SignInSourceDisconnected();
    throw error;
  }
}
