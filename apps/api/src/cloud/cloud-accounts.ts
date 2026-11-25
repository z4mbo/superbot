import type { CloudRefusal } from "@rakazo/contracts/cloud-web";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export interface LocalAccount {
  id: string;
  email: string;
  name: string;
}

export type CloudAccountResult =
  | { ok: true; account: LocalAccount }
  | { ok: false; refusal: Extract<CloudRefusal, "account_not_allowed" | "no_local_account"> };

/** The reads the mapping needs, so it can be tested without a database. */
export interface LocalAccountDirectory {
  /** Matched without regard to case. */
  byEmail(email: string): Promise<(LocalAccount & { usable: boolean }) | null>;
  /** Up to two sign-in accounts, enough to tell whether the server has exactly one. */
  firstTwo(): Promise<(LocalAccount & { usable: boolean })[]>;
}

/**
 * Which local account a verified cloud email signs in as. The operator lists every cloud
 * account that may sign in; an entry names its local account, or means the one with the same
 * email, or on a server with a single account, that account. Never creates an account.
 */
export async function mapCloudAccount(
  allowed: ReadonlyMap<string, string | null>,
  directory: LocalAccountDirectory,
  normalizedEmail: string,
): Promise<CloudAccountResult> {
  if (!allowed.has(normalizedEmail)) return { ok: false, refusal: "account_not_allowed" };
  const named = allowed.get(normalizedEmail);
  let found = await directory.byEmail(named ?? normalizedEmail);
  if (!found && !named) {
    const accounts = await directory.firstTwo();
    if (accounts.length === 1) found = accounts[0]!;
  }
  if (!found?.usable) return { ok: false, refusal: "no_local_account" };
  return { ok: true, account: { id: found.id, email: found.email, name: found.name } };
}

const ACCOUNT_FIELDS = { id: true, email: true, name: true, deactivatedAt: true } as const;
/** Chat users a messaging app created are not accounts anyone signs in to. */
const SIGN_IN_ACCOUNT = { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } } as const;

/** Callers run these in a system database context: the lookup spans every account. */
export function prismaAccountDirectory(prisma: PrismaClient): LocalAccountDirectory {
  const usable = (user: LocalAccount & { deactivatedAt: Date | null }) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    usable: user.deactivatedAt === null,
  });
  return {
    byEmail: async (email) => {
      const user = await prisma.user.findFirst({
        where: { ...SIGN_IN_ACCOUNT, email: { equals: email, mode: "insensitive" } },
        select: ACCOUNT_FIELDS,
        orderBy: { createdAt: "asc" },
      });
      return user && usable(user);
    },
    firstTwo: async () =>
      (
        await prisma.user.findMany({
          where: SIGN_IN_ACCOUNT,
          select: ACCOUNT_FIELDS,
          orderBy: { createdAt: "asc" },
          take: 2,
        })
      ).map(usable),
  };
}
