import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type {
  Bot,
  CommunityTemplateDraft,
  CommunityTemplateListing,
  CommunityTemplateRecipe,
  CommunityTemplateSubmission,
} from "@rakazo/contracts";
import { BOT_TEMPLATE_CHANGED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Created = { bot: Bot; created: boolean };

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const origin = "http://127.0.0.1:5173";

// Values a shared template must never carry; each is planted where the bot keeps it.
const SECRET_VALUE = "fixture-secret-value-7f3a9c";
const SECRET_NAME = "FIXTURE_SERVICE_TOKEN";
const MEMORY_TEXT = "fixture memory: the side door code is 4321";
const MODEL_ID = "fixture-model-private";
const PRIVATE_SKILL = "Private notes";

describeIntegration("community agent templates", () => {
  let app: App;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  const composio = new ComposioConnector({ client: new FakeComposioClient() });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-community-templates-"));
  const adminEmail = `admin-${stamp}@rakazo.test`;
  const authorEmail = `author-${stamp}@rakazo.test`;
  let author: string;
  let other: string;
  let admin: string;
  let authorScope: { spaceId: string; userId: string };
  let botId: string;
  let draft: CommunityTemplateDraft;
  // Distinct per run, so the slugs this test claims never meet an earlier run's.
  const name = (label: string) => `${label} ${stamp}`;

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      webOrigin: origin,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      adminEmails: [adminEmail],
      composio,
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    stop = handles.stop;
    author = await signup(app, authorEmail, "Ana Author");
    other = await signup(app, `other-${stamp}@rakazo.test`, "Other Person");
    admin = await signup(app, adminEmail, "Fixture Admin");
    await db.user.update({ where: { email: adminEmail }, data: { emailVerified: true } });
    authorScope = await scopeOf(author);
  });

  afterAll(async () => {
    await db?.communityTemplate.deleteMany({ where: { slug: { contains: stamp } } });
    await stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("drafts a recipe from the owner's bot and nothing personal", async () => {
    const bot = await rpc<Bot>(app, author, "bots/create", {
      name: name("Weekly digest"),
      description: "Weekly digest",
      instructions: "You write a weekly digest. Use @Weekly report on Fridays.",
    });
    botId = bot.id;
    await rpc(app, author, "agentSkills/create", {
      name: "Weekly report",
      description: "Write the weekly report.",
      body: "1. Gather the week.\n2. Summarize it.",
    });
    await rpc(app, author, "agentSkills/create", {
      name: PRIVATE_SKILL,
      description: "Personal notes.",
      body: "Never shared.",
    });
    await rpc(app, author, "routines/create", {
      botId,
      name: "Friday digest",
      prompt: "Send the digest with @Weekly report.",
      crons: ["0 9 * * 5"],
    });
    await rpc(app, author, "agentSecrets/put", { name: SECRET_NAME, value: SECRET_VALUE });
    await db.memoryDocument.create({
      data: { ...authorScope, botId, scope: "bot", path: "notes.md", content: MEMORY_TEXT },
    });
    await db.bot.update({
      where: { id: botId },
      data: { modelProvider: "fixture-provider", modelId: MODEL_ID },
    });
    await composio.begin(
      { provider: "gmail", redirectUrl: "http://127.0.0.1.invalid/callback" },
      {
        operationId: "community-template-test",
        traceId: "community-template-test",
        ...authorScope,
        signal: new AbortController().signal,
      },
    );

    draft = await rpc<CommunityTemplateDraft>(app, author, "communityTemplates/draft", { botId });
    expect(draft).toMatchObject({
      name: name("Weekly digest"),
      category: null,
      instructions: "You write a weekly digest. Use @Weekly report on Fridays.",
      skills: [
        {
          name: "Weekly report",
          description: "Write the weekly report.",
          body: "1. Gather the week.\n2. Summarize it.",
        },
      ],
      routines: [
        {
          name: "Friday digest",
          prompt: "Send the digest with @Weekly report.",
          crons: ["0 9 * * 5"],
        },
      ],
    });
    expect(draft.apps).toContain("gmail");
    expectNothingPersonal(draft);

    // Only the owner may share a bot: anyone else is told it doesn't exist.
    expect((await raw(app, other, "communityTemplates/draft", { botId })).status).toBe(404);
  });

  it("validates a submission like a first-party template and keeps it private until approved", async () => {
    const recipe = shareable(draft);
    expect((await raw(app, other, "communityTemplates/submit", { botId, recipe })).status).toBe(
      404,
    );
    const strict = await raw(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...recipe, memory: [MEMORY_TEXT] },
    });
    expect(strict.status).toBe(400);
    const keyed = await raw(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...recipe, instructions: `${recipe.instructions}\nToken: ghp_${"a1".repeat(20)}` },
    });
    expect(keyed.status).toBe(400);
    const shadow = await raw(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...recipe, name: "Morning briefing" },
    });
    expect(shadow.status).toBe(409);

    const submitted = await rpc<CommunityTemplateSubmission>(
      app,
      author,
      "communityTemplates/submit",
      { botId, recipe },
    );
    expect(submitted).toMatchObject({ status: "pending", version: 1, author: "Ana Author" });
    const stored = await db.communityTemplateVersion.findUniqueOrThrow({
      where: { id: submitted.id },
    });
    expect(stored.recipe).toEqual(recipe);
    expectNothingPersonal(stored.recipe);

    expect(await listed(other)).toEqual([]);
    // The first author keeps the name.
    const { id: otherBot } = await rpc<Bot>(app, other, "bots/create", { name: "Copycat" });
    const taken = await raw(app, other, "communityTemplates/submit", { botId: otherBot, recipe });
    expect(taken.status).toBe(409);
  });

  it("caps an author's waiting submissions and replaces one resubmitted while it waits", async () => {
    for (const label of ["Second agent", "Third agent"]) {
      await rpc(app, author, "communityTemplates/submit", {
        botId,
        recipe: { ...shareable(draft), name: name(label) },
      });
    }
    const fourth = await raw(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...shareable(draft), name: name("Fourth agent") },
    });
    expect(fourth.status).toBe(429);

    const again = await rpc<CommunityTemplateSubmission>(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...shareable(draft), summary: "A sharper weekly digest" },
    });
    expect(again.version).toBe(2);
    const mine = await rpc<CommunityTemplateSubmission[]>(app, author, "communityTemplates/mine");
    expect(mine.filter((item) => item.status === "pending")).toHaveLength(3);
    expect(mine.find((item) => item.version === 1 && item.slug === again.slug)?.status).toBe(
      "withdrawn",
    );
    // Authors see only their own.
    expect(await rpc(app, other, "communityTemplates/mine")).toEqual([]);
  });

  it("lets only admins review, and lists what they approve with the author's public name", async () => {
    expect((await raw(app, author, "communityTemplates/queue", { status: "pending" })).status).toBe(
      403,
    );
    const queue = await rpc<CommunityTemplateSubmission[]>(app, admin, "communityTemplates/queue", {
      status: "pending",
    });
    const ours = queue.filter((item) => item.slug.includes(stamp));
    const digest = ours.find((item) => item.recipe.name === name("Weekly digest"))!;
    const second = ours.find((item) => item.recipe.name === name("Second agent"))!;
    expect(digest.recipe.instructions).toBe(draft.instructions);
    expect(
      (await raw(app, author, "communityTemplates/review", { id: digest.id, decision: "approve" }))
        .status,
    ).toBe(403);
    expect(
      (await raw(app, admin, "communityTemplates/review", { id: second.id, decision: "reject" }))
        .status,
    ).toBe(400);

    await rpc(app, admin, "communityTemplates/review", {
      id: second.id,
      decision: "reject",
      reason: "Add an example message that shows real output.",
    });
    await rpc(app, admin, "communityTemplates/review", { id: digest.id, decision: "approve" });
    const again = await raw(app, admin, "communityTemplates/review", {
      id: digest.id,
      decision: "approve",
    });
    expect(again.status).toBe(409);

    const mine = await rpc<CommunityTemplateSubmission[]>(app, author, "communityTemplates/mine");
    expect(mine.find((item) => item.id === second.id)).toMatchObject({
      status: "rejected",
      reason: "Add an example message that shows real output.",
    });
    const shown = await listed(other);
    expect(shown).toEqual([
      expect.objectContaining({
        id: digest.slug,
        version: 2,
        author: "Ana Author",
        botId: null,
        category: "research",
      }),
    ]);
    expect(JSON.stringify(shown)).not.toContain(authorEmail);
  });

  it("creates a bot from a community template with the version check, paused like first-party", async () => {
    const [template] = await listed(other);
    const stale = await raw(app, other, "bots/createFromTemplate", {
      templateId: template!.id,
      version: template!.version + 1,
    });
    expect(stale.status).toBe(412);
    expect(JSON.stringify(await stale.json())).toContain(BOT_TEMPLATE_CHANGED);

    const { bot, created } = await rpc<Created>(app, other, "bots/createFromTemplate", {
      templateId: template!.id,
      version: template!.version,
    });
    expect(created).toBe(true);
    expect(bot.instructions).toBe(template!.instructions);
    const routines = await db.routine.findMany({ where: { botId: bot.id } });
    expect(routines.map((row) => [row.name, row.active])).toEqual([["Friday digest", false]]);
    expect((await listed(other))[0]?.botId).toBe(bot.id);

    // A newer version replaces the listed one only once approved.
    const v3 = await rpc<CommunityTemplateSubmission>(app, author, "communityTemplates/submit", {
      botId,
      recipe: { ...shareable(draft), summary: "Third take" },
    });
    expect((await listed(other))[0]?.version).toBe(2);
    await rpc(app, admin, "communityTemplates/review", { id: v3.id, decision: "approve" });
    expect((await listed(other))[0]).toMatchObject({ version: 3, summary: "Third take" });

    // Unlisting takes it out of the Store; the bot made from it keeps working.
    expect((await raw(app, other, "communityTemplates/unlist", { id: v3.id })).status).toBe(404);
    await rpc(app, author, "communityTemplates/unlist", { id: v3.id });
    expect(await listed(other)).toEqual([]);
    expect((await rpc<Bot>(app, other, "bots/get", { botId: bot.id })).instructions).toBe(
      template!.instructions,
    );
    expect(
      (
        await raw(app, other, "bots/createFromTemplate", {
          templateId: template!.id,
          version: 3,
        })
      ).status,
    ).toBe(404);
  });

  it("lets the author withdraw what waits and admins unlist what is listed", async () => {
    const mine = await rpc<CommunityTemplateSubmission[]>(app, author, "communityTemplates/mine");
    const third = mine.find((item) => item.recipe.name === name("Third agent"))!;
    expect((await raw(app, other, "communityTemplates/withdraw", { id: third.id })).status).toBe(
      404,
    );
    await rpc(app, author, "communityTemplates/withdraw", { id: third.id });
    expect((await raw(app, author, "communityTemplates/withdraw", { id: third.id })).status).toBe(
      409,
    );

    const fourth = await rpc<CommunityTemplateSubmission>(
      app,
      author,
      "communityTemplates/submit",
      { botId, recipe: { ...shareable(draft), name: name("Fourth agent") } },
    );
    await rpc(app, admin, "communityTemplates/review", { id: fourth.id, decision: "approve" });
    await rpc(app, admin, "communityTemplates/unlist", { id: fourth.id, reason: "Out of date." });
    const after = await rpc<CommunityTemplateSubmission[]>(app, author, "communityTemplates/mine");
    expect(after.find((item) => item.id === fourth.id)).toMatchObject({
      status: "unlisted",
      reason: "Out of date.",
    });
  });

  it("keeps an approved template listed without a name once its author's account is gone", async () => {
    const userId = `gone-${stamp}`;
    const slug = `gone-${stamp}`;
    await db.user.create({
      data: { id: userId, email: `${userId}@rakazo.test`, name: "Gone Author" },
    });
    await db.communityTemplate.create({ data: { slug, authorId: userId } });
    await db.communityTemplateVersion.create({
      data: {
        slug,
        version: 1,
        status: "approved",
        reviewedAt: new Date(),
        recipe: { ...shareable(draft), name: "Gone agent" },
      },
    });
    const pending = await db.communityTemplateVersion.create({
      data: { slug, version: 2, recipe: { ...shareable(draft), name: "Gone agent" } },
    });
    await db.user.delete({ where: { id: userId } });

    expect(await db.communityTemplate.findUnique({ where: { slug } })).toMatchObject({
      authorId: null,
    });
    expect((await listed(other)).find((item) => item.id === slug)).toMatchObject({ author: null });
    const queue = await rpc<CommunityTemplateSubmission[]>(app, admin, "communityTemplates/queue", {
      status: "pending",
    });
    expect(queue.some((item) => item.id === pending.id)).toBe(false);
    expect(
      (await raw(app, admin, "communityTemplates/review", { id: pending.id, decision: "approve" }))
        .status,
    ).toBe(409);
  });

  function listed(cookie: string) {
    return rpc<CommunityTemplateListing[]>(app, cookie, "communityTemplates/list").then((items) =>
      items.filter((item) => item.id.includes(stamp)),
    );
  }

  function expectNothingPersonal(value: unknown) {
    const text = JSON.stringify(value);
    for (const forbidden of [
      SECRET_VALUE,
      SECRET_NAME,
      MEMORY_TEXT,
      MODEL_ID,
      "fixture-provider",
      PRIVATE_SKILL,
      authorEmail,
      authorScope.userId,
      authorScope.spaceId,
      botId,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  }

  async function scopeOf(cookie: string) {
    const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
    return { spaceId: me.spaceId, userId: me.userId };
  }
});

function shareable(draft: CommunityTemplateDraft): CommunityTemplateRecipe {
  return {
    ...draft,
    category: "research",
    summary: "A weekly digest of what changed",
    sample: "**This week**\n- Two releases shipped",
  };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: body }),
  });
}
