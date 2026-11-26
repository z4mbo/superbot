import type {
  AdapterContext,
  SignInAccessState,
  SignInFillCall,
  SignInFillPort,
  SignInSourceConnectStart,
  SignInSourceCredential,
  SignInSourceProvider,
} from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  EMULATOR_LOGIN,
  EmulatorSignInSourceProvider,
  emulatorExtensionFill,
} from "./sign-in-source-emulator.js";

export const testContext: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

type Row = Record<string, unknown>;

/** Equality, `not`, `gt` and `in` on plain fields, as the sign-in code queries them. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof Date)
      return row[key] instanceof Date && (row[key] as Date).getTime() === value.getTime();
    if (value && typeof value === "object") {
      const filter = value as { not?: unknown; gt?: Date; in?: unknown[] };
      if ("not" in filter) return row[key] !== filter.not && row[key] !== undefined;
      if (filter.gt) return row[key] instanceof Date && (row[key] as Date) > filter.gt;
      if (filter.in) return filter.in.includes(row[key]);
      return true;
    }
    return (row[key] ?? null) === value;
  });
}

function table(rows: Row[], prefix: string) {
  let next = 1;
  const newest = (a: Row, b: Row) =>
    Number(b.createdAt ?? b.resolvedAt ?? 0) - Number(a.createdAt ?? a.resolvedAt ?? 0);
  return {
    rows,
    findUnique: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      if (!row) throw new Error(`No ${prefix} row`);
      return row;
    },
    findFirst: async ({ where }: { where: Row }) =>
      rows.filter((row) => matches(row, where)).sort(newest)[0] ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `${prefix}-${next++}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      if (!row) throw new Error(`No ${prefix} row`);
      return Object.assign(row, data);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      if (row) return Object.assign(row, update);
      const created = { id: `${prefix}-${next++}`, createdAt: new Date(), ...create };
      rows.push(created);
      return created;
    },
    delete: async ({ where }: { where: Row }) => {
      const index = rows.findIndex((row) => matches(row, where));
      return rows.splice(index, 1)[0];
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (matches(rows[index]!, where)) rows.splice(index, 1);
      return { count: before - rows.length };
    },
  };
}

/** The tables the sign-in code reads and writes, in memory; locks and transactions just run. */
export function signInTables() {
  const signInSource = table([], "source");
  const signInRequest = table([], "request");
  const secret = table([], "secret");
  const client = {
    signInSource,
    signInRequest,
    secret,
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client as unknown as PrismaClient, signInSource, signInRequest, secret };
}

/**
 * The emulator with test controls: the answer each status check gets (the emulator's own by
 * default), an approval link with characters a parse-and-rebuild would change, and a switch that
 * makes every call fail as a revoked connection does.
 */
export class FakeCredentialBroker extends EmulatorSignInSourceProvider {
  requests: Array<{ site: string; goal: string }> = [];
  checks = 0;
  revokedRemotely = false;
  answer: (request: { id: string }) => SignInAccessState | undefined = () => undefined;
  approvalLink = (id: string) =>
    `https://sign-in.emulator.invalid/approve?ref=${encodeURIComponent(id)}&x=%7E%2F%20+A~`;

  override async requestAccess(
    credential: SignInSourceCredential,
    request: { site: string; goal: string },
    context: AdapterContext,
  ) {
    if (this.revokedRemotely) throw new SignInSourceDisconnected();
    this.requests.push(request);
    const created = await super.requestAccess(credential, request, context);
    return { ...created, approvalLink: this.approvalLink(created.id) };
  }

  override async accessState(
    credential: SignInSourceCredential,
    request: { id: string; entryId: string },
    context: AdapterContext,
  ) {
    this.checks += 1;
    if (this.revokedRemotely) throw new SignInSourceDisconnected();
    return this.answer(request) ?? super.accessState(credential, request, context);
  }
}

/**
 * The emulator's browser extension on a page of its own: it types the fixture login into its
 * page, as a real extension does, and answers the caller with a status only.
 */
export class FakeFillExtension implements SignInFillPort {
  calls: Array<{ origin: string; call: SignInFillCall }> = [];
  page = "";
  outcome: "submitted" | "no_active_grant" | "disconnected" | "failed" = "submitted";

  async fill(request: { origin: string; call: SignInFillCall }) {
    this.calls.push(request);
    const answer = emulatorExtensionFill(request.call);
    if ("status" in answer) return answer;
    if (this.outcome === "submitted")
      this.page = `${answer.login.username} ${answer.login.password} ${answer.login.oneTimeCode}`;
    return { status: this.outcome };
  }
}

export const FIXTURE_LOGIN_VALUES = Object.values(EMULATOR_LOGIN);

/**
 * What every sign-in source owes core, run offline against a provider and its fakes. `callback`
 * is what the provider's sign-in page sends back to the redirect page for `start`.
 */
export function signInSourceConformance(
  name: string,
  make: () => Promise<SignInSourceProvider>,
  callback: (start: SignInSourceConnectStart) => {
    code: string;
    state: string;
    fragment?: Record<string, string>;
  },
) {
  const redirectUri = "https://app.example.test/sign-in-source/callback";
  describe(`${name} sign-in source contract`, () => {
    it("describes itself with a name, a grant lifetime and its approval link schemes", async () => {
      const source = await make();
      const { capabilities } = source.describe();
      expect(source.displayName.length).toBeGreaterThan(0);
      expect(capabilities.grantDays).toBeGreaterThan(0);
      expect(capabilities.approvalLinkSchemes.length).toBeGreaterThan(0);
    });

    it("connects, asks for a login, and fills only through its own call with the grant reference", async () => {
      const source = await make();
      const start = await source.beginConnect({ redirectUri }, testContext);
      expect(start.state.length).toBeGreaterThan(8);
      const credential = await source.finishConnect(
        { pending: start.pending, redirectUri, callback: callback(start) },
        testContext,
      );
      const request = await source.requestAccess(
        credential,
        { site: "https://example.test", goal: "Sign in" },
        testContext,
      );
      expect(
        source
          .describe()
          .capabilities.approvalLinkSchemes.some((scheme) => request.approvalLink.startsWith(scheme)),
      ).toBe(true);
      const answer = await source.accessState(credential, request, testContext);
      expect(answer.state).toBe("approved");
      if (answer.state !== "approved") return;
      const call = source.fillCall(credential, answer.reference);
      expect(Object.values(call.params)).toContain(answer.reference);
      // Nothing a provider hands core names a login's values.
      const handed = JSON.stringify({ start, request, answer, call, credential });
      for (const value of FIXTURE_LOGIN_VALUES) expect(handed).not.toContain(value);
      // Anything but a submitted fill is not read as one.
      expect(source.fillOutcome(undefined).status).toBe("failed");
      expect(source.fillOutcome({ status: "fill_submitted" }).status).not.toBe("submitted");

      await source.disconnect(credential, testContext);
      await expect(source.refresh(credential, testContext)).rejects.toBeInstanceOf(
        SignInSourceDisconnected,
      );
    });
  });
}
