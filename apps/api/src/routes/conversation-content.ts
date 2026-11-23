import { conversationLibrary } from "../threads/conversation-library.js";
import { listInbox, setInboxState } from "../threads/inbox.js";
import { resolveThreadTarget } from "../threads/thread-target.js";
import type { RouterContext } from "./context.js";

export function conversationContentRoutes({ authed, deps }: RouterContext) {
  return {
    inbox: {
      list: authed.inbox.list.handler(({ context, input }) =>
        listInbox(deps.prisma, context.actor, input.includeDone),
      ),
      setState: authed.inbox.setState.handler(async ({ context, input }) => {
        await setInboxState(deps.prisma, context.actor, input);
        await deps.events?.publishRosterChange?.({ userIds: [context.actor.userId] });
        return { ok: true as const };
      }),
    },
    conversationLibrary: {
      list: authed.conversationLibrary.list.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return conversationLibrary(deps.prisma, context.actor, target.threadId);
      }),
    },
  };
}
