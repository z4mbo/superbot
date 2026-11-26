import { managedAppCatalog } from "../account/onboarding.js";
import { isAdmin, requireAdmin } from "../auth/admins.js";
import { communityTemplateDraft, communityTemplates } from "../bots/community-templates.js";
import type { RouterContext } from "./context.js";

export function communityTemplatesRoutes({ deps, authed }: RouterContext) {
  const rpc = authed.communityTemplates;
  const templates = communityTemplates(deps);
  return {
    communityTemplates: {
      list: rpc.list.handler(({ context }) => templates.list(context.actor)),
      draft: rpc.draft.handler(({ context, input }) =>
        communityTemplateDraft(
          deps,
          (botId) =>
            managedAppCatalog(deps.connectors, context.actor, "communityTemplates.draft", botId),
          context.actor,
          input.botId,
        ),
      ),
      submit: rpc.submit.handler(({ context, input }) => templates.submit(context.actor, input)),
      mine: rpc.mine.handler(({ context }) => templates.mine(context.actor)),
      withdraw: rpc.withdraw.handler(({ context, input }) =>
        templates.withdraw(context.actor, input.id),
      ),
      unlist: rpc.unlist.handler(async ({ context, input }) =>
        templates.unlist(context.actor, input, await isAdmin(deps, context.actor.userId)),
      ),
      queue: rpc.queue.handler(async ({ context, input }) => {
        await requireAdmin(deps, context.actor.userId);
        return templates.queue(input.status);
      }),
      review: rpc.review.handler(async ({ context, input }) => {
        await requireAdmin(deps, context.actor.userId);
        return templates.review(context.actor, input);
      }),
    },
  };
}
