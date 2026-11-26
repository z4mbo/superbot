import type {
  AdapterContext,
  SignInSourceCredential,
  SignInSourceProvider,
} from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets/secrets.js";
import {
  disconnectSignInSource,
  finishSignInSourceConnect,
  SignInSourceConnectError,
  SignInSourceRevokeError,
  SignInSourceUnavailableError,
  signInSourceConnected,
  signInSourceState,
  startSignInSourceConnect,
  withSignInCredential,
} from "./sign-in-source-connections.js";
import { EmulatorSignInSourceProvider } from "./sign-in-source-emulator.js";
import { signInTables } from "./sign-in-sources.test-support.js";

const actor = { userId: "user-1", spaceId: "space-1" };
const WEB = "https://app.example.test";

/** The emulator, with a refresh that rotates the token and a switch to make revoking fail. */
class RotatingEmulator extends EmulatorSignInSourceProvider {
  refreshes = 0;
  revokeFails = false;
  finished: Array<SignInSourceCredential | undefined> = [];

  override async finishConnect(
    request: Parameters<SignInSourceProvider["finishConnect"]>[0],
    context: AdapterContext,
  ) {
    this.finished.push(request.previous);
    const credential = await super.finishConnect(request, context);
    return { ...credential, refreshAt: new Date(Date.now() - 1_000) };
  }

  override async refresh(credential: SignInSourceCredential, context: AdapterContext) {
    await super.refresh(credential, context);
    this.refreshes += 1;
    return { secret: credential.secret, refreshAt: new Date(Date.now() + 3_600_000) };
  }

  override async disconnect(credential: SignInSourceCredential, context: AdapterContext) {
    if (this.revokeFails) throw new Error("provider unavailable");
    await super.disconnect(credential, context);
  }
}

function setup(provider: SignInSourceProvider | null = new RotatingEmulator()) {
  const tables = signInTables();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const deps = { prisma: tables.prisma, secretStore, signInSource: provider, webOrigin: WEB };
  return { deps, tables, provider };
}

/** What the emulator's page sends back to the redirect page. */
function callbackOf(authorizeUrl: string) {
  const back = new URL(authorizeUrl);
  return {
    code: back.searchParams.get("code") ?? "",
    state: back.searchParams.get("state") ?? "",
    fragment: Object.fromEntries(new URLSearchParams(back.hash.slice(1))),
  };
}

describe("connecting a sign-in source", () => {
  it("is absent without a provider, and refuses to start without a registration", async () => {
    expect(await signInSourceState(setup(null).deps, actor)).toBeNull();
    const closed = new RotatingEmulator();
    vi.spyOn(closed, "describe").mockReturnValue({
      ...closed.describe(),
      capabilities: { ...closed.describe().capabilities, connectable: false },
    });
    const { deps } = setup(closed);
    expect(await signInSourceState(deps, actor)).toMatchObject({
      label: "Emulator Passwords",
      connectable: false,
      status: "disconnected",
    });
    await expect(startSignInSourceConnect(deps, actor)).rejects.toBeInstanceOf(
      SignInSourceUnavailableError,
    );
  });

  it("binds the redirect to the person who started it, then keeps only a sealed reference", async () => {
    const { deps, tables } = setup();
    const { authorizeUrl } = await startSignInSourceConnect(deps, actor);
    expect(authorizeUrl.startsWith(`${WEB}/sign-in-source/callback?`)).toBe(true);
    expect(await signInSourceState(deps, actor)).toMatchObject({ status: "connecting" });
    const callback = callbackOf(authorizeUrl);
    // Another person, or another state, cannot finish it.
    await expect(
      finishSignInSourceConnect(deps, { ...actor, userId: "user-2" }, callback),
    ).rejects.toBeInstanceOf(SignInSourceConnectError);
    await expect(
      finishSignInSourceConnect(deps, actor, { ...callback, state: "forged" }),
    ).rejects.toBeInstanceOf(SignInSourceConnectError);
    const state = await finishSignInSourceConnect(deps, actor, callback);
    expect(state).toMatchObject({ status: "connected", connectedAt: expect.any(String) });
    expect(await signInSourceConnected(deps, actor.userId)).toBe(true);
    // The row names its sealed material; the pending connect's material is gone.
    const [row] = tables.signInSource.rows;
    expect(tables.secret.rows.map((secret) => secret.id)).toEqual([row?.secretId]);
    expect(JSON.stringify(tables.signInSource.rows)).not.toContain("emulator-token");
    expect(String(tables.secret.rows[0]?.ciphertext)).not.toContain("emulator-token");
    // A finished connect cannot be finished twice.
    await expect(finishSignInSourceConnect(deps, actor, callback)).rejects.toBeInstanceOf(
      SignInSourceConnectError,
    );
  });

  it("refuses a redirect after the connect window closed", async () => {
    const { deps, tables } = setup();
    const { authorizeUrl } = await startSignInSourceConnect(deps, actor);
    const [row] = tables.signInSource.rows;
    if (row) row.connectExpiresAt = new Date(Date.now() - 1);
    await expect(
      finishSignInSourceConnect(deps, actor, callbackOf(authorizeUrl)),
    ).rejects.toBeInstanceOf(SignInSourceConnectError);
    expect(await signInSourceState(deps, actor)).toMatchObject({ status: "disconnected" });
  });

  it("refreshes a due credential once under the lock, and marks a dropped one for reconnecting", async () => {
    const provider = new RotatingEmulator();
    const { deps, tables } = setup(provider);
    const { authorizeUrl } = await startSignInSourceConnect(deps, actor);
    await finishSignInSourceConnect(deps, actor, callbackOf(authorizeUrl));
    const before = tables.signInSource.rows[0]?.secretId;
    const used = await withSignInCredential(deps, actor, async (credential) => credential.secret);
    expect(used.startsWith("emulator-token:")).toBe(true);
    expect(provider.refreshes).toBe(1);
    // The refreshed material replaced the old one.
    expect(tables.signInSource.rows[0]?.secretId).not.toBe(before);
    expect(tables.secret.rows).toHaveLength(1);
    await withSignInCredential(deps, actor, async () => undefined);
    expect(provider.refreshes).toBe(1);
    // The provider no longer accepts it: the person is asked to connect again.
    await expect(
      withSignInCredential(deps, actor, async () => {
        throw new SignInSourceDisconnected();
      }),
    ).rejects.toBeInstanceOf(SignInSourceDisconnected);
    expect(await signInSourceState(deps, actor)).toMatchObject({ status: "needs_reconnect" });
    expect(await signInSourceConnected(deps, actor.userId)).toBe(false);
  });

  it("reconnects with what the provider sent on first consent", async () => {
    const provider = new RotatingEmulator();
    const { deps, tables } = setup(provider);
    const first = await startSignInSourceConnect(deps, actor);
    await finishSignInSourceConnect(deps, actor, callbackOf(first.authorizeUrl));
    const [row] = tables.signInSource.rows;
    if (row) row.status = "needs_reconnect";
    const again = await startSignInSourceConnect(deps, actor);
    // This time the provider's page sends no key: the one from the first consent is used.
    const { fragment: _none, ...callback } = callbackOf(again.authorizeUrl);
    expect(await finishSignInSourceConnect(deps, actor, callback)).toMatchObject({
      status: "connected",
    });
    expect(provider.finished[1]?.secret.startsWith("emulator-token:")).toBe(true);
  });

  it("revokes before forgetting, and keeps the connection when the provider won't revoke", async () => {
    const provider = new RotatingEmulator();
    const { deps, tables } = setup(provider);
    const { authorizeUrl } = await startSignInSourceConnect(deps, actor);
    await finishSignInSourceConnect(deps, actor, callbackOf(authorizeUrl));
    provider.revokeFails = true;
    await expect(disconnectSignInSource(deps, actor)).rejects.toBeInstanceOf(
      SignInSourceRevokeError,
    );
    expect(tables.signInSource.rows).toHaveLength(1);
    provider.revokeFails = false;
    expect(await disconnectSignInSource(deps, actor)).toMatchObject({ status: "disconnected" });
    expect(tables.signInSource.rows).toHaveLength(0);
    expect(tables.secret.rows).toHaveLength(0);
  });
});
