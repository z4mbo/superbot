import type {
  AdapterContext,
  SignInAccessState,
  SignInFillCall,
  SignInFillPort,
  SignInSourceCredential,
} from "@rakazo/adapter-kit";
import { EMULATOR_FILL_METHOD, EmulatorSignInSourceProvider } from "./sign-in-source-emulator.js";

/** Values the fake password manager holds for every login. None may ever leave it. */
export const FIXTURE_LOGIN = {
  username: "fixture-user-7c1@example.test",
  password: "fixture-pass-9f3",
  otp: "fixture-otp-482913",
} as const;

/**
 * A fake credential broker: the emulator, plus the login values a real password manager holds
 * and a counter on the one call that would read them, which the sign-in path must never make.
 */
export class FakeCredentialBroker extends EmulatorSignInSourceProvider {
  loginReads = 0;
  requests: Array<{ site: string; goal: string }> = [];
  /** The answer each status check gets; approve by default. */
  answer: (request: { id: string }) => SignInAccessState | undefined = () => undefined;
  /** An approval link returned exactly as a provider might, with characters a rebuild would change. */
  approvalLink = (id: string) =>
    `https://sign-in.emulator.invalid/approve?ref=${encodeURIComponent(id)}&x=%7E%2F%20+A~`;

  override async requestAccess(
    credential: SignInSourceCredential,
    request: { site: string; goal: string },
    context: AdapterContext,
  ) {
    this.requests.push(request);
    const created = await super.requestAccess(credential, request, context);
    return { ...created, approvalLink: this.approvalLink(created.id) };
  }

  override async accessState(
    credential: SignInSourceCredential,
    request: { id: string; entryId: string },
    context: AdapterContext,
  ) {
    return this.answer(request) ?? super.accessState(credential, request, context);
  }

  /** What a provider's value-reading call returns; the sign-in path must never call it. */
  readLogin(): typeof FIXTURE_LOGIN {
    this.loginReads += 1;
    return FIXTURE_LOGIN;
  }
}

/**
 * A fake browser extension: it holds the login values itself and types them into its page, as a
 * real password manager's extension does, and answers only "submitted" to the caller.
 */
export class FakeFillExtension implements SignInFillPort {
  calls: Array<{ origin: string; call: SignInFillCall }> = [];
  page = "";
  outcome: "submitted" | "no_active_grant" | "disconnected" | "failed" = "submitted";

  async fill(request: { origin: string; call: SignInFillCall }) {
    this.calls.push(request);
    if (request.call.method !== EMULATOR_FILL_METHOD) return { status: "failed" };
    if (this.outcome === "submitted")
      this.page = `${FIXTURE_LOGIN.username} ${FIXTURE_LOGIN.password} ${FIXTURE_LOGIN.otp}`;
    return { status: this.outcome };
  }
}

/**
 * Fails when any login value appears anywhere in `values`, however deeply nested. A local stand-in
 * for the vault's shared leak assertion, which can replace it once that lands.
 */
export function expectNoLoginValues(values: unknown): void {
  const text = JSON.stringify(values, (_key, value) =>
    value instanceof Date ? value.toISOString() : value,
  );
  for (const secret of Object.values(FIXTURE_LOGIN))
    if (text.includes(secret)) throw new Error(`A login value leaked: ${secret.slice(0, 8)}…`);
}
