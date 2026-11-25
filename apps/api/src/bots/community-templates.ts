import type { TransactionalEmail } from "@rakazo/adapter-kit";
import {
  communityTemplateAdminEmail,
  communityTemplateReviewedEmail,
  emailLocale,
} from "@rakazo/auth";
import type {
  Actor,
  BotTemplate,
  CommunityTemplateDraft,
  CommunityTemplateListing,
  CommunityTemplateRecipe,
  CommunityTemplateReview,
  CommunityTemplateSubmission,
  ConnectionCatalogItem,
} from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TEMPLATE_IMPORT_KEY_PREFIX,
  COMMUNITY_TEMPLATE_PENDING_LIMIT,
  CommunityTemplateRecipeSchema,
  CreateRoutineInput,
} from "@rakazo/contracts";
import {
  buildSkillMd,
  ClientError,
  displayName,
  extractRoutineSkillMentions,
  findBotTemplate,
  findSkillByName,
  looksLikeCredential,
  parseSkillMd,
} from "@rakazo/core";
import type { CommunityTemplateVersion, Prisma, PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
} from "@rakazo/db";
import { windowCounter } from "../http/window-counter.js";
import type { RouterDeps } from "../router.js";
import { lockOwner } from "../spaces/name-claims.js";

const HOUR_MS = 60 * 60_000;
const SUBMITS_PER_USER_PER_HOUR = 10;
// Each new submission mails every admin, so one inbox gets a bounded number a day; past it the
// submission still waits for review.
const ADMIN_NOTICES_PER_EMAIL_PER_DAY = 20;
const LIST_LIMIT = 500;
const SKILL_LIMIT = 5;
const ROUTINE_LIMIT = 5;
const APP_LIMIT = 6;

export type CommunityTemplateDeps = Pick<RouterDeps, "prisma" | "email" | "onEmailError"> & {
  env: Pick<RouterDeps["env"], "adminEmails" | "webOrigin">;
};

/** Import keys of bots made from community templates; apart from first-party templates' keys. */
export function communityImportKey(slug: string): string {
  return `${BOT_TEMPLATE_IMPORT_KEY_PREFIX}community:${slug}`;
}

/**
 * The slug a template's name claims: the first author to submit it keeps it, and submitting the
 * same name again is a new version. A name with no a–z or 0–9 gets a stable hashed slug.
 */
export function communityTemplateSlug(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  if (words) return words;
  // FNV-1a over the lowercased name, so a script without Latin letters still names one slug.
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `agent-${hash.toString(36)}`;
}

/** What others see of the author: their account name, unless it is or comes from their email. */
export function publicAuthorName(user: { name: string; email: string } | null): string | null {
  if (!user) return null;
  const name = displayName(user.name, "");
  if (!name || name.includes("@")) return null;
  const email = user.email.toLowerCase();
  const lower = name.toLowerCase();
  return lower === email || lower === email.split("@")[0] ? null : name;
}

type VersionRow = CommunityTemplateVersion & {
  template: { authorId: string | null; author: { name: string; email: string } | null };
};

const VERSION_INCLUDE = {
  template: { select: { authorId: true, author: { select: { name: true, email: true } } } },
} satisfies Prisma.CommunityTemplateVersionInclude;

function readRecipe(row: CommunityTemplateVersion): CommunityTemplateRecipe {
  return readJsonColumn(
    CommunityTemplateRecipeSchema,
    row.recipe,
    { table: "community_template_versions", column: "recipe", id: row.id },
    "reject",
  );
}

function submissionDto(row: VersionRow): CommunityTemplateSubmission {
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    status: row.status as CommunityTemplateSubmission["status"],
    reason: row.reason,
    recipe: readRecipe(row),
    author: publicAuthorName(row.template.author),
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

/** A row whose recipe no longer reads is left out and reported, never guessed at. */
function readable<Row, Item>(rows: Row[], dto: (row: Row) => Item): Item[] {
  return rows.flatMap((row) => {
    try {
      return [dto(row)];
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce(error.message, error.row);
      return [];
    }
  });
}

async function ownedBot(prisma: PrismaClient, actor: Actor, botId: string) {
  // Only the bot's owner may share it; a bot someone else owns reads as missing.
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, name: true, label: true, description: true, instructions: true },
  });
  if (!bot) throw new ClientError("NOT_FOUND", "Bot not found");
  return bot;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * The recipe a bot would share: its instructions, the user's own skills it mentions, its
 * routines' names, prompts and schedules, and the apps connected for it, by catalog slug. Nothing
 * else is read: no keys or vault entries, model or provider settings, servers, memory, history,
 * files, avatars or members.
 */
export async function communityTemplateDraft(
  deps: Pick<RouterDeps, "prisma">,
  appCatalog: (botId: string) => Promise<ConnectionCatalogItem[]>,
  actor: Actor,
  botId: string,
): Promise<CommunityTemplateDraft> {
  const bot = await ownedBot(deps.prisma, actor, botId);
  const routines = await deps.prisma.routine.findMany({
    where: { botId: bot.id, spaceId: actor.spaceId, userId: actor.userId },
    select: { name: true, prompt: true, crons: true },
    orderBy: { createdAt: "asc" },
  });
  const scheduled = routines.filter((routine) => routine.crons.length > 0).slice(0, ROUTINE_LIMIT);
  // Skills are shared across a user's bots; this bot's are the user's own it mentions by name.
  const userSkills = await deps.prisma.agentSkill.findMany({
    where: { ...availableInSpace(actor), source: "user" },
    select: { name: true, content: true },
    orderBy: { createdAt: "asc" },
  });
  const text = [bot.instructions, ...scheduled.map((routine) => routine.prompt)].join("\n");
  const mentioned = extractRoutineSkillMentions(
    text,
    userSkills.map((skill) => skill.name),
  );
  const skills = mentioned.flatMap((name) => {
    const skill = findSkillByName(userSkills, name);
    const parsed = skill ? parseSkillMd(skill.content) : null;
    if (!parsed || "error" in parsed) return [];
    return [
      {
        name: clip(parsed.name, 64),
        description: clip(parsed.description, 2000),
        body: clip(parsed.body.trim(), 20_000),
      },
    ];
  });
  const apps = [
    ...new Set(
      (await appCatalog(bot.id))
        .filter((entry) => entry.connected)
        // Catalog slugs match case-insensitively; a template keeps the lowercase form.
        .map((entry) => entry.slug.toLowerCase())
        .filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)),
    ),
  ];
  return {
    name: clip(bot.name, BOT_NAME_MAX_LENGTH),
    category: null,
    summary: clip(bot.label ?? "", 120),
    sample: "",
    description: clip(bot.description, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: clip(bot.instructions, BOT_INSTRUCTIONS_MAX_LENGTH),
    skills: skills.slice(0, SKILL_LIMIT),
    routines: scheduled.map((routine) => ({
      name: clip(routine.name, 80),
      prompt: clip(routine.prompt, 4000),
      crons: routine.crons.slice(0, 5),
    })),
    apps: apps.slice(0, APP_LIMIT),
  };
}

function strings(recipe: CommunityTemplateRecipe): string[] {
  return [
    recipe.name,
    recipe.summary,
    recipe.sample,
    recipe.description,
    recipe.instructions,
    ...recipe.skills.flatMap((skill) => [skill.name, skill.description, skill.body]),
    ...recipe.routines.flatMap((routine) => [routine.name, routine.prompt]),
  ];
}

/** What the schema cannot say: no credentials, distinct skill names, routines that would install. */
function assertShareable(recipe: CommunityTemplateRecipe) {
  if (strings(recipe).some(looksLikeCredential)) {
    throw new ClientError("BAD_REQUEST", "Remove what looks like a key or token before sharing.");
  }
  const names = recipe.skills.map((skill) => skill.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new ClientError("BAD_REQUEST", "Give each skill its own name.");
  }
  for (const skill of recipe.skills) buildSkillMd(skill);
  for (const routine of recipe.routines) {
    const parsed = CreateRoutineInput.safeParse({
      botId: "pending",
      name: routine.name,
      prompt: routine.prompt,
      crons: routine.crons,
      timezone: "UTC",
      active: false,
    });
    if (!parsed.success) {
      throw new ClientError("BAD_REQUEST", `The routine "${routine.name}" can't be shared as is.`);
    }
  }
}

export function communityTemplates(deps: CommunityTemplateDeps) {
  const { prisma } = deps;
  const submits = windowCounter(HOUR_MS);
  const adminNotices = windowCounter(24 * HOUR_MS);

  // The provider tracks the send, so shutdown drains it; requests do not wait on delivery.
  const sendLater = (build: () => Promise<TransactionalEmail>) => {
    const email = deps.email;
    if (email)
      void build()
        .then((message) => email.send(message))
        .catch((e) => deps.onEmailError?.(e));
  };

  const notifyAdmins = (name: string, version: number) => {
    const reviewUrl = new URL("/admin/apps", deps.env.webOrigin).href;
    for (const admin of deps.env.adminEmails ?? []) {
      if (adminNotices(admin.trim().toLowerCase()) > ADMIN_NOTICES_PER_EMAIL_PER_DAY) continue;
      sendLater(() => communityTemplateAdminEmail(admin, { name, version }, reviewUrl));
    }
  };

  const notifyAuthor = (
    authorId: string | null,
    name: string,
    status: "approved" | "rejected" | "unlisted",
    reason: string | null,
  ) => {
    if (!authorId) return;
    sendLater(async () => {
      const author = await prisma.user.findUniqueOrThrow({
        where: { id: authorId },
        select: { email: true, locale: true },
      });
      return communityTemplateReviewedEmail(
        { email: author.email, name, status, reason },
        emailLocale(author.locale),
      );
    });
  };

  const findVersion = (id: string) =>
    prisma.communityTemplateVersion.findUnique({ where: { id }, include: VERSION_INCLUDE });

  return {
    /** Approved templates, newest first, apart from any whose slug a first-party template took. */
    async list(actor: Actor): Promise<CommunityTemplateListing[]> {
      const rows = await prisma.communityTemplateVersion.findMany({
        where: { status: "approved" },
        include: VERSION_INCLUDE,
        orderBy: { reviewedAt: "desc" },
        take: LIST_LIMIT,
      });
      const listed = rows.filter((row) => !findBotTemplate(row.slug));
      const made = await prisma.agentImport.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          importKey: { in: listed.map((row) => communityImportKey(row.slug)) },
          bot: { archivedAt: null },
        },
        select: { importKey: true, botId: true },
      });
      const bots = new Map(made.map((row) => [row.importKey, row.botId]));
      return readable(listed, (row) => ({
        ...readRecipe(row),
        id: row.slug,
        version: row.version,
        botId: bots.get(communityImportKey(row.slug)) ?? null,
        author: publicAuthorName(row.template.author),
      }));
    },

    async submit(
      actor: Actor,
      input: { botId: string; recipe: CommunityTemplateRecipe },
    ): Promise<CommunityTemplateSubmission> {
      await ownedBot(prisma, actor, input.botId);
      if (submits(actor.userId) > SUBMITS_PER_USER_PER_HOUR) {
        throw new ClientError("TOO_MANY_REQUESTS", "Too many submissions. Try again later.");
      }
      const recipe = CommunityTemplateRecipeSchema.parse(input.recipe);
      assertShareable(recipe);
      const slug = communityTemplateSlug(recipe.name);
      if (findBotTemplate(slug)) {
        throw new ClientError("CONFLICT", "A Superbot agent already has this name. Pick another.");
      }
      const { row, created } = await prisma.$transaction(async (tx) => {
        // One submit per slug and per author at a time, so the cap and versions hold.
        await lockOwner(tx, actor.userId, "community-template-author");
        await lockOwner(tx, slug, "community-template-slug");
        const template = await tx.communityTemplate.findUnique({ where: { slug } });
        if (template && template.authorId !== actor.userId) {
          throw new ClientError("CONFLICT", "Another agent already has this name. Pick another.");
        }
        if (!template) {
          await tx.communityTemplate.create({ data: { slug, authorId: actor.userId } });
        }
        // Submitting again while one waits replaces it: the waiting one is withdrawn, so an
        // admin only ever approves exactly what they were shown.
        const replaced = await tx.communityTemplateVersion.updateMany({
          where: { slug, status: "pending" },
          data: { status: "withdrawn" },
        });
        const pending = await tx.communityTemplateVersion.count({
          where: { status: "pending", template: { authorId: actor.userId } },
        });
        if (pending >= COMMUNITY_TEMPLATE_PENDING_LIMIT) {
          throw new ClientError(
            "TOO_MANY_REQUESTS",
            "You have too many agents waiting for review. Wait for one to be reviewed.",
          );
        }
        const latest = await tx.communityTemplateVersion.aggregate({
          where: { slug },
          _max: { version: true },
        });
        const row = await tx.communityTemplateVersion.create({
          data: { slug, version: (latest._max.version ?? 0) + 1, recipe, status: "pending" },
          include: VERSION_INCLUDE,
        });
        return { row, created: replaced.count === 0 };
      });
      if (created) notifyAdmins(recipe.name, row.version);
      return submissionDto(row);
    },

    async mine(actor: Actor): Promise<CommunityTemplateSubmission[]> {
      const rows = await prisma.communityTemplateVersion.findMany({
        where: { template: { authorId: actor.userId } },
        include: VERSION_INCLUDE,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return readable(rows, submissionDto);
    },

    async withdraw(actor: Actor, id: string): Promise<CommunityTemplateSubmission> {
      const row = await findVersion(id);
      if (!row || row.template.authorId !== actor.userId) {
        throw new ClientError("NOT_FOUND", "Submission not found");
      }
      const done = await prisma.communityTemplateVersion.updateMany({
        where: { id, status: "pending" },
        data: { status: "withdrawn" },
      });
      if (done.count === 0) throw new ClientError("CONFLICT", "This was already reviewed.");
      return submissionDto((await findVersion(id))!);
    },

    async unlist(
      actor: Actor,
      input: { id: string; reason?: string },
      admin: boolean,
    ): Promise<CommunityTemplateSubmission> {
      const row = await findVersion(input.id);
      const author = row?.template.authorId === actor.userId;
      if (!row || (!author && !admin)) throw new ClientError("NOT_FOUND", "Submission not found");
      const reason = author ? null : (input.reason ?? null);
      const done = await prisma.communityTemplateVersion.updateMany({
        where: { id: row.id, status: "approved" },
        data: { status: "unlisted", reason, ...(author ? {} : { reviewerId: actor.userId }) },
      });
      if (done.count === 0) throw new ClientError("CONFLICT", "This isn't listed.");
      if (!author) notifyAuthor(row.template.authorId, readRecipe(row).name, "unlisted", reason);
      return submissionDto((await findVersion(row.id))!);
    },

    /** Admins only: the caller checks. Waiting ones oldest first; an author's deleted ones drop out. */
    async queue(status: "pending" | "approved"): Promise<CommunityTemplateSubmission[]> {
      const rows = await prisma.communityTemplateVersion.findMany({
        where: {
          status,
          ...(status === "pending" ? { template: { authorId: { not: null } } } : {}),
        },
        include: VERSION_INCLUDE,
        orderBy: status === "pending" ? { createdAt: "asc" } : { reviewedAt: "desc" },
        take: 200,
      });
      return readable(rows, submissionDto);
    },

    /** Admins only: the caller checks. Approving replaces the listed version of the same slug. */
    async review(
      actor: Actor,
      input: CommunityTemplateReview,
    ): Promise<CommunityTemplateSubmission> {
      const row = await findVersion(input.id);
      if (!row) throw new ClientError("NOT_FOUND", "Submission not found");
      const recipe = readRecipe(row);
      const decided = await prisma.$transaction(async (tx) => {
        await lockOwner(tx, row.slug, "community-template-slug");
        const current = await tx.communityTemplateVersion.findUnique({
          where: { id: row.id },
          include: { template: { select: { authorId: true } } },
        });
        if (current?.status !== "pending") {
          throw new ClientError("CONFLICT", "Changed or already reviewed. Reload to see it.");
        }
        if (!current.template.authorId) {
          throw new ClientError("CONFLICT", "The author's account was deleted.");
        }
        const reviewed = { reviewerId: actor.userId, reviewedAt: new Date() };
        if (input.decision === "approve") {
          await tx.communityTemplateVersion.updateMany({
            where: { slug: row.slug, status: "approved" },
            data: { status: "replaced" },
          });
        }
        await tx.communityTemplateVersion.update({
          where: { id: row.id },
          data:
            input.decision === "approve"
              ? { ...reviewed, status: "approved", reason: null }
              : { ...reviewed, status: "rejected", reason: input.reason },
        });
        return current.template.authorId;
      });
      notifyAuthor(
        decided,
        recipe.name,
        input.decision === "approve" ? "approved" : "rejected",
        input.decision === "reject" ? input.reason : null,
      );
      return submissionDto((await findVersion(row.id))!);
    },
  };
}

/** The listed community template with this slug, as a template a bot can be made from. */
export async function listedCommunityTemplate(
  prisma: PrismaClient,
  slug: string,
): Promise<BotTemplate | null> {
  const row = await prisma.communityTemplateVersion.findFirst({
    where: { slug, status: "approved" },
  });
  return row ? { ...readRecipe(row), id: row.slug, version: row.version } : null;
}
