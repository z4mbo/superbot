import type { SignInSourceDeps } from "@rakazo/adapters";
import {
  disconnectSignInSource,
  finishSignInSourceConnect,
  reviewSignInRequest,
  SignInSourceUnavailableError,
  signInSourceState,
  startSignInSourceConnect,
} from "@rakazo/adapters";
import { changeSignInBlock } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterContext } from "./context.js";

export function signInSourceRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const source: SignInSourceDeps = {
    prisma: deps.prisma,
    secretStore: deps.secrets,
    signInSource: deps.signInSource,
    webOrigin: deps.env.webOrigin,
  };
  return {
    signInSource: {
      status: authed.signInSource.status.handler(({ context }) =>
        signInSourceState(source, context.actor),
      ),
      connect: authed.signInSource.connect.handler(({ context }) =>
        startSignInSourceConnect(source, context.actor),
      ),
      finishConnect: authed.signInSource.finishConnect.handler(({ context, input }) =>
        finishSignInSourceConnect(source, context.actor, input),
      ),
      disconnect: authed.signInSource.disconnect.handler(({ context }) =>
        disconnectSignInSource(source, context.actor),
      ),
      review: authed.signInSource.review.handler(({ context, input }) => {
        if (!deps.signInSource) throw new SignInSourceUnavailableError();
        // The card says it was opened, which is what the bot's waiting call listens for.
        return reviewSignInRequest(source, context.actor, input.requestId, async (request) => {
          if (!request.messageId) return;
          const { seq } = await changeSignInBlock(
            deps.prisma,
            { spaceId: request.spaceId, threadId: request.threadId, messageId: request.messageId },
            (block) =>
              block.requestId === request.id && !block.opened ? { ...block, opened: true } : undefined,
          );
          if (seq !== undefined)
            await bestEffort("sign-in card", deps.events.notify(request.threadId, seq));
        });
      }),
    },
  };
}
