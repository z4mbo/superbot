import { oc } from "@orpc/contract";
import * as z from "zod";

/** One provider a person can save a web research key for. The key itself is never sent back. */
export const ResearchKeyProviderSchema = z.object({
  /** Opaque provider id. */
  id: z.string(),
  /** The provider's name, from its descriptor. */
  label: z.string(),
  /** What the key unlocks, from its descriptor. */
  capability: z.enum(["search", "page_read"]),
  /** Whether this account has a key saved for it. */
  saved: z.boolean(),
});
export type ResearchKeyProvider = z.infer<typeof ResearchKeyProviderSchema>;

export const ResearchKeySaveSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  key: z.string().trim().min(1).max(4096),
});
export type ResearchKeySave = z.infer<typeof ResearchKeySaveSchema>;

const ResearchKeyListSchema = z.array(ResearchKeyProviderSchema);

export const researchKeysRpc = {
  /** Account-level keys for the optional web research tools. */
  researchKeys: {
    list: oc.output(ResearchKeyListSchema),
    save: oc.input(ResearchKeySaveSchema).output(ResearchKeyListSchema),
    remove: oc
      .input(z.object({ provider: z.string().trim().min(1).max(64) }))
      .output(ResearchKeyListSchema),
  },
};
