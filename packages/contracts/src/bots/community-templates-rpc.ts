import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import {
  CommunityTemplateDraftSchema,
  CommunityTemplateListingSchema,
  CommunityTemplateReviewInput,
  CommunityTemplateSubmissionSchema,
  SubmitCommunityTemplateInput,
  UnlistCommunityTemplateInput,
} from "./community-template.js";

export const communityTemplatesRpc = {
  communityTemplates: {
    /** Approved templates people shared; a bot is made from one with `bots.createFromTemplate`. */
    list: oc.output(z.array(CommunityTemplateListingSchema)),
    /** A recipe read from a bot the caller owns, for them to edit before submitting. */
    draft: oc.input(botId).output(CommunityTemplateDraftSchema),
    submit: oc.input(SubmitCommunityTemplateInput).output(CommunityTemplateSubmissionSchema),
    /** The caller's own submissions, newest first. */
    mine: oc.output(z.array(CommunityTemplateSubmissionSchema)),
    withdraw: oc.input(z.strictObject({ id: Id })).output(CommunityTemplateSubmissionSchema),
    /** The author's or an admin's: takes an approved template out of the Store. */
    unlist: oc.input(UnlistCommunityTemplateInput).output(CommunityTemplateSubmissionSchema),
    /** Admins only. */
    queue: oc
      .input(z.strictObject({ status: z.enum(["pending", "approved"]) }))
      .output(z.array(CommunityTemplateSubmissionSchema)),
    /** Admins only. */
    review: oc.input(CommunityTemplateReviewInput).output(CommunityTemplateSubmissionSchema),
  },
};
