import type { InferRouterInitialContext } from "@orpc/server";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, Bot } from "@rakazo/contracts";
import { withModelRoles } from "../../../packages/adapters/src/models/model-roles.test-support.js";
import type { RouterDeps } from "./router.js";
import {
  createRouter as createRouterWith,
  enqueueBotIntroRun as enqueueBotIntroRunWith,
} from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

export {
  mainRole,
  withModelRoles,
} from "../../../packages/adapters/src/models/model-roles.test-support.js";

/**
 * Routine saves read and write app events, and save them in one transaction with the routine.
 * A hand-built client that leaves them out has none, and runs a transaction on itself.
 */
function withNoAppEvents(prisma: unknown) {
  const client = prisma as Record<string, unknown> | null;
  if (!client || typeof client !== "object") return;
  client.routineAppEvent ??= {
    findMany: async () => [],
    findFirst: async () => null,
    count: async () => 0,
    createMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };
  client.$transaction ??= async (work: unknown) =>
    typeof work === "function" ? work(client) : Promise.all(work as Promise<unknown>[]);
}

const withRoleDeps = (deps: RouterDeps) => {
  withModelRoles(deps.prisma);
  withNoAppEvents(deps.prisma);
  return deps;
};
export const createRouter = (deps: RouterDeps) => createRouterWith(withRoleDeps(deps));
/** A handler that answers errors as the app does, so a domain error keeps its own status. */
export const appHandler = (deps: RouterDeps) =>
  new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
export const enqueueBotIntroRun = (deps: RouterDeps, ...rest: [Actor, Bot]) =>
  enqueueBotIntroRunWith(withRoleDeps(deps), ...rest);

export type RouterHandler = RPCHandler<InferRouterInitialContext<ReturnType<typeof createRouter>>>;

// Every path these tests call is routed, so a missing response is a broken test.
export async function handle(handler: RouterHandler, ...args: Parameters<RouterHandler["handle"]>) {
  const { response } = await handler.handle(...args);
  if (!response) throw new Error("no response");
  return response;
}
