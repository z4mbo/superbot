import * as z from "zod";
import { Id } from "../ids.js";
import { BotTemplateListingSchema, BotTemplateSchema } from "./bot-template.js";

/**
 * What a person shares of their bot: a template without its id and version, which the server
 * assigns. The same strict schema as first-party templates, so a shared template can carry no
 * keys, memory, history, models, servers or files either.
 */
export const CommunityTemplateRecipeSchema = BotTemplateSchema.omit({ id: true, version: true });
export type CommunityTemplateRecipe = z.infer<typeof CommunityTemplateRecipeSchema>;

/**
 * The recipe the server reads from a bot, for its owner to finish before submitting. Lenient
 * where a bot may not fit yet (an empty summary, a skill name a template cannot use); the
 * submit is checked against the recipe schema.
 */
export const CommunityTemplateDraftSchema = z.object({
  name: z.string(),
  summary: z.string(),
  sample: z.string(),
  description: z.string(),
  instructions: z.string(),
  skills: z.array(z.object({ name: z.string(), description: z.string(), body: z.string() })),
  routines: z.array(z.object({ name: z.string(), prompt: z.string(), crons: z.array(z.string()) })),
  apps: z.array(z.string()),
});
export type CommunityTemplateDraft = z.infer<typeof CommunityTemplateDraftSchema>;

export const COMMUNITY_TEMPLATE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  /** The author took it back before review. */
  "withdrawn",
  /** Taken out of the Store by its author or an admin. */
  "unlisted",
  /** A newer approved version of the same template took its place. */
  "replaced",
] as const;
export const CommunityTemplateStatusSchema = z.enum(COMMUNITY_TEMPLATE_STATUSES);
export type CommunityTemplateStatus = z.infer<typeof CommunityTemplateStatusSchema>;

/** Pending submissions one author may have waiting at a time. */
export const COMMUNITY_TEMPLATE_PENDING_LIMIT = 3;

export const CommunityTemplateSubmissionSchema = z.object({
  id: Id,
  slug: z.string(),
  version: z.number().int().positive(),
  status: CommunityTemplateStatusSchema,
  /** Why it was rejected or unlisted by an admin. */
  reason: z.string().nullable(),
  recipe: CommunityTemplateRecipeSchema,
  /** The author's public name; null when they have none or their account was deleted. */
  author: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type CommunityTemplateSubmission = z.infer<typeof CommunityTemplateSubmissionSchema>;

/** An approved community template as the Store lists it; its id is its slug. */
export const CommunityTemplateListingSchema = BotTemplateListingSchema.extend({
  author: z.string().nullable(),
});
export type CommunityTemplateListing = z.infer<typeof CommunityTemplateListingSchema>;

export const SubmitCommunityTemplateInput = z.strictObject({
  /** The bot it was shared from; only its owner may share it. Not stored. */
  botId: Id,
  recipe: CommunityTemplateRecipeSchema,
});

export const CommunityTemplateReviewInput = z.discriminatedUnion("decision", [
  z.strictObject({ id: Id, decision: z.literal("approve") }),
  z.strictObject({
    id: Id,
    decision: z.literal("reject"),
    reason: z.string().trim().min(1).max(1000),
  }),
]);
export type CommunityTemplateReview = z.infer<typeof CommunityTemplateReviewInput>;

export const UnlistCommunityTemplateInput = z.strictObject({
  id: Id,
  /** Shown to the author when an admin unlists it. */
  reason: z.string().trim().min(1).max(1000).optional(),
});
