import type { OAuthCredential } from "@earendil-works/pi-ai";
import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredModelSecret } from "../models/model-secret.js";
import { serializeModelSecret } from "../models/model-secret.js";
import { PlanLimitsReader, readMemberPlanLimits } from "./plan-limits.js";
import { readMemberProviderUsage } from "./provider-usage.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: NOW + 3_600_000,
    ...overrides,
  } as OAuthCredential;
}

const claudeBody = {
  five_hour: { utilization: 42, resets_at: "2026-11-10T15:00:00Z" },
  seven_day: { utilization: 12.5, resets_at: "2026-11-14T00:00:00Z" },
  seven_day_opus: { utilization: 90, resets_at: "2026-11-14T00:00:00Z" },
};
const openRouterBody = {
  data: { limit: null, limit_remaining: null, limit_reset: null, usage: 3.25, is_free_tier: false },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type Row = { id: string; provider: string; label: string; secretId: string };

function member(rows: Row[], secrets: Record<string, StoredModelSecret | string | undefined>) {
  return {
    prisma: {
      userModelCredential: { findMany: vi.fn(async () => rows) },
      secret: {
        findMany: vi.fn(async () =>
          rows
            .filter((row) => secrets[row.secretId] !== undefined)
            .map((row) => ({ id: row.secretId, ciphertext: row.secretId })),
        ),
      },
    } as never,
    secretStore: {
      load: async (ciphertext: string) => {
        const secret = secrets[ciphertext];
        return typeof secret === "string" ? secret : serializeModelSecret(secret!);
      },
    },
  };
}

function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  });
}

let now = NOW;
beforeEach(() => {
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readMemberProviderUsage", () => {
  it("lists every connection with its usage or the reason there is none", async () => {
    const rows: Row[] = [
      { id: "c1", provider: "anthropic", label: "me@example.com", secretId: "s1" },
      { id: "c2", provider: "openai-codex", label: "ChatGPT", secretId: "s2" },
      { id: "c3", provider: "openrouter", label: "Router", secretId: "s3" },
      { id: "c4", provider: "xai", label: "Grok", secretId: "s4" },
      { id: "c5", provider: "anthropic", label: "Console key", secretId: "s5" },
      { id: "c6", provider: "deepseek", label: "Deep", secretId: "s6" },
      { id: "c7", provider: "moonshotai", label: "Kimi", secretId: "s7" },
      { id: "c8", provider: "vercel-ai-gateway", label: "Gateway", secretId: "s8" },
      { id: "c9", provider: "openrouter", label: "Gone", secretId: "missing" },
      { id: "c10", provider: "openrouter", label: "Corrupt", secretId: "s10" },
    ];
    const key = (value: string): StoredModelSecret => ({ kind: "api_key", key: value });
    const { prisma, secretStore } = member(rows, {
      s1: { kind: "oauth", credential: credential() },
      s2: { kind: "oauth", reconnectRequired: true },
      s3: key("sk-or-test"),
      s4: key("xai-test"),
      s5: key("sk-ant-test"),
      s6: key("sk-deep-test"),
      s7: key("sk-moon-test"),
      s8: key("gw-test"),
      s10: JSON.stringify({ kind: "openai_compatible" }),
    });
    const fetchImpl = routedFetch({
      "https://api.anthropic.com/api/oauth/usage": () => json(claudeBody),
      "https://openrouter.ai/api/v1/key": () => json(openRouterBody),
      "https://api.deepseek.com/user/balance": () => json({ error: "bad key" }, 401),
      "https://api.moonshot.ai/v1/users/me/balance": () => json({ error: "down" }, 503),
      "https://ai-gateway.vercel.sh/v1/credits": () => json({}),
    });
    const usage = await readMemberProviderUsage(
      prisma,
      secretStore,
      "u1",
      new PlanLimitsReader(fetchImpl as typeof fetch, () => now),
      vi.fn(),
    );
    const readAt = new Date(NOW).toISOString();
    expect(
      usage.map(({ credentialId, name, kind, status }) => [credentialId, name, kind, status]),
    ).toEqual([
      ["c1", "Claude", "subscription", "ok"],
      ["c2", "ChatGPT", "subscription", "not_signed_in"],
      ["c3", "OpenRouter", "api_key", "ok"],
      ["c4", "xAI", "api_key", "unavailable"],
      ["c5", "Anthropic", "api_key", "unavailable"],
      ["c6", "DeepSeek", "api_key", "not_signed_in"],
      ["c7", "Moonshot AI", "api_key", "error"],
      ["c8", "Vercel AI Gateway", "api_key", "no_data"],
      ["c9", "OpenRouter", "api_key", "error"],
      ["c10", "OpenRouter", "api_key", "error"],
    ]);
    expect(usage[0]).toMatchObject({
      provider: "anthropic",
      label: "me@example.com",
      plan: null,
      readAt,
      credits: null,
    });
    expect(usage[0]?.windows).toContainEqual({
      period: "week",
      usedPercent: 90,
      resetsAt: "2026-11-14T00:00:00.000Z",
      model: "Opus",
    });
    expect(usage[2]).toMatchObject({
      windows: [],
      credits: { usedUsd: 3.25, limitUsd: null, remainingUsd: null, period: null, resetsAt: null },
      readAt,
    });
    for (const row of usage.slice(3)) {
      expect(row.windows).toEqual([]);
      expect(row.credits).toBeNull();
    }
    expect(usage[7]?.readAt).toBe(readAt);
    expect(usage[3]?.readAt).toBeNull();
    const authorization = (url: string) => {
      const call = fetchImpl.mock.calls.find(([called]) => called === url) as unknown as [
        string,
        RequestInit,
      ];
      return (call[1].headers as Record<string, string>).authorization;
    };
    expect(authorization("https://openrouter.ai/api/v1/key")).toBe("Bearer sk-or-test");
    expect(authorization("https://api.deepseek.com/user/balance")).toBe("Bearer sk-deep-test");
  });

  it("reads all of the member's connections to allowed providers", async () => {
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    try {
      const rows: Row[] = [
        { id: "c1", provider: "anthropic", label: "Claude", secretId: "s1" },
        { id: "c2", provider: "openrouter", label: "Router", secretId: "s2" },
      ];
      const { prisma, secretStore } = member(rows, {
        s1: { kind: "oauth", credential: credential() },
        s2: { kind: "api_key", key: "sk-or-test" },
      });
      const fetchImpl = routedFetch({
        "https://openrouter.ai/api/v1/key": () => json(openRouterBody),
      });
      const usage = await readMemberProviderUsage(
        prisma,
        secretStore,
        "u1",
        new PlanLimitsReader(fetchImpl as typeof fetch, () => now),
        vi.fn(),
      );
      expect(usage.map((row) => row.credentialId)).toEqual(["c2"]);
      expect(
        (prisma as { userModelCredential: { findMany: ReturnType<typeof vi.fn> } })
          .userModelCredential.findMany,
      ).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows an expired sign-in's last reading while its refresh runs, and an error without one", async () => {
    const rows: Row[] = [{ id: "c1", provider: "anthropic", label: "Claude", secretId: "s1" }];
    let secret: StoredModelSecret = { kind: "oauth", credential: credential() };
    const { prisma, secretStore } = member(rows, { s1: "placeholder" });
    secretStore.load = async () => serializeModelSecret(secret);
    const fetchImpl = vi.fn(async () => json(claudeBody));
    const onExpired = vi.fn();
    const read = (reader: PlanLimitsReader) =>
      readMemberProviderUsage(prisma, secretStore, "u1", reader, onExpired);

    const cold = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    secret = { kind: "oauth", credential: credential({ expires: NOW - 1 }) };
    expect((await read(cold))[0]).toMatchObject({ status: "error", windows: [], readAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onExpired).toHaveBeenCalledWith("s1", "anthropic");

    const warm = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    secret = { kind: "oauth", credential: credential() };
    await read(warm);
    now += 120_000;
    secret = { kind: "oauth", credential: credential({ expires: NOW }) };
    expect((await read(warm))[0]).toMatchObject({
      status: "ok",
      readAt: new Date(NOW).toISOString(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the last good reading after a failure until it is stale", async () => {
    const rows: Row[] = [{ id: "c1", provider: "openrouter", label: "Router", secretId: "s1" }];
    const { prisma, secretStore } = member(rows, { s1: { kind: "api_key", key: "sk-or-test" } });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(openRouterBody))
      .mockImplementation(async () => json({ error: "down" }, 500));
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    const read = async () =>
      (await readMemberProviderUsage(prisma, secretStore, "u1", reader, vi.fn()))[0];
    await read();
    now += 120_000;
    expect(await read()).toMatchObject({
      status: "ok",
      credits: { usedUsd: 3.25 },
      readAt: new Date(NOW).toISOString(),
    });
    // A failure is not retried straight away.
    now += 5_000;
    await read();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = NOW + 31 * 60_000;
    expect(await read()).toMatchObject({
      status: "error",
      credits: null,
      readAt: new Date(NOW).toISOString(),
    });
  });

  it("reports a sign-in the provider rejects", async () => {
    const rows: Row[] = [{ id: "c1", provider: "anthropic", label: "Claude", secretId: "s1" }];
    const { prisma, secretStore } = member(rows, {
      s1: { kind: "oauth", credential: credential() },
    });
    const reader = new PlanLimitsReader(
      (async () => json({ error: "revoked" }, 403)) as typeof fetch,
      () => now,
    );
    const [row] = await readMemberProviderUsage(prisma, secretStore, "u1", reader, vi.fn());
    expect(row).toMatchObject({ status: "not_signed_in", windows: [], credits: null });
  });
});

describe("PlanLimitsReader usage refresh", () => {
  const secret = { kind: "api_key", key: "sk-or-test" } as const;

  it("asks again on refresh, but not within ten seconds of the last attempt", async () => {
    const fetchImpl = vi.fn(async () => json(openRouterBody));
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    await reader.usage("k", "openrouter", secret);
    now += 5_000;
    await reader.usage("k", "openrouter", secret, { refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 6_000;
    await reader.usage("k", "openrouter", secret);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const refreshed = await reader.usage("k", "openrouter", secret, { refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshed.readAt).toBe(now);
  });

  it("never starts a second read while one is in flight", async () => {
    const answer = deferred<Response>();
    const fetchImpl = vi.fn(() => answer.promise);
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    const first = reader.usage("k", "openrouter", secret);
    now += 30_000;
    const second = reader.usage("k", "openrouter", secret, { refresh: true });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    answer.resolve(json(openRouterBody));
    expect((await first).status).toBe("ok");
    expect((await second).status).toBe("ok");
  });

  it("shares readings with the subscription allowance list, which keeps only shared windows", async () => {
    const rows: Row[] = [
      { id: "c1", provider: "anthropic", label: "me@example.com", secretId: "s1" },
    ];
    const { prisma, secretStore } = member(rows, {
      s1: { kind: "oauth", credential: credential() },
    });
    const fetchImpl = vi.fn(async () => json(claudeBody));
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    await readMemberProviderUsage(prisma, secretStore, "u1", reader, vi.fn());
    const plans = await readMemberPlanLimits(prisma, secretStore, "u1", reader, vi.fn());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(plans).toEqual([
      {
        credentialId: "c1",
        name: "Claude",
        label: "me@example.com",
        windows: [
          { period: "session", usedPercent: 42, resetsAt: "2026-11-10T15:00:00.000Z" },
          { period: "week", usedPercent: 12.5, resetsAt: "2026-11-14T00:00:00.000Z" },
        ],
      },
    ]);
  });
});
