import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";

type Row = {
  id: string;
  userId: string;
  spaceId: string | null;
  kind: string;
  ciphertext: string;
  createdAt: Date;
};

type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    const value = row[field as keyof Row];
    if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
      const filter = wanted as { in?: unknown[]; not?: unknown };
      if (filter.in) return filter.in.includes(value);
      if ("not" in filter) return value !== filter.not;
    }
    return value === wanted;
  });
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((field) => [field, row[field as keyof Row]]));
}

/** The `secrets` table in memory, filtering the way the queries ask, and a store that seals inline. */
export function researchKeyFakes() {
  const rows: Row[] = [];
  let clock = 0;
  const secret = {
    findMany: vi.fn(async ({ where, select }: { where: Where; select?: Record<string, boolean> }) =>
      rows.filter((row) => matches(row, where)).map((row) => pick(row, select)),
    ),
    findFirst: vi.fn(
      async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
        const found = rows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return found ? pick(found, select) : null;
      },
    ),
    create: vi.fn(async ({ data }: { data: Omit<Row, "createdAt"> }) => {
      const row = { ...data, createdAt: new Date(++clock) };
      rows.push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      let count = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index]!, where)) {
          rows.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    }),
  };
  const prisma = {
    secret,
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
  } as unknown as PrismaClient;
  let sealed = 0;
  const secrets = {
    put: vi.fn(async (plaintext: string) => {
      const ciphertext = `sealed:${Buffer.from(plaintext).toString("base64")}`;
      return { id: `secret-${++sealed}`, ref: ciphertext, ciphertext };
    }),
    load: vi.fn(async (ref: string) =>
      Buffer.from(ref.slice("sealed:".length), "base64").toString(),
    ),
    delete: vi.fn(async () => undefined),
    isRemote: () => false,
  };
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
  };
  return { rows, prisma, secrets, jobs };
}
