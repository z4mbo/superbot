import { createHash, timingSafeEqual } from "node:crypto";
import { hasActiveComputerControl } from "@rakazo/adapters";
import {
  openScreenCapability,
  SCREEN_TARGET_ENDPOINT,
  verifyScreenProof,
} from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { holdsUserControl, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { requestBodyLimit } from "../http/request-body-limit.js";

export function mountScreenTarget(
  app: Hono,
  prisma: PrismaClient,
  secret: string,
  readSessionId: (cookie: string) => Promise<string | undefined>,
) {
  app.post(SCREEN_TARGET_ENDPOINT, requestBodyLimit(32 * 1024), async (c) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      !secret ||
      supplied.length === 0 ||
      !timingSafeEqual(
        createHash("sha256").update(supplied).digest(),
        createHash("sha256").update(expected).digest(),
      )
    )
      return c.body(null, 403);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.path !== "string") return c.body(null, 403);
    const capability = openScreenCapability(body.path, secret);
    if (!capability) return c.body(null, 403);
    const { scope, target } = capability;
    const { sessionId, spaceId } = scope;
    if (!sessionId || !spaceId) return c.body(null, 403);
    const access = body.access;
    const proofAllowed =
      typeof access?.proof === "string" &&
      typeof access.origin === "string" &&
      (access.purpose === "native" || access.purpose === "socket" || access.purpose === "asset") &&
      verifyScreenProof(access.proof, body.path, secret, access.origin, access.purpose);
    const computer = await runAsSystem("authorize a screen proxy request", async () => {
      if (!proofAllowed) {
        if (
          typeof access?.cookie !== "string" ||
          (await readSessionId(access.cookie)) !== sessionId
        )
          return null;
      }
      const session = await prisma.session.findFirst({
        where: { id: sessionId, expiresAt: { gt: new Date() }, user: { deactivatedAt: null } },
        select: { userId: true },
      });
      if (!session) return null;
      const bot = await prisma.bot.findFirst({
        where: {
          id: scope.botId,
          spaceId,
          space: { deletingAt: null, memberships: { some: { userId: session.userId } } },
          computerId: scope.computerId,
          computer: { spaceId },
          archivedAt: null,
          screenGeneration: scope.botGeneration,
        },
        select: {
          computer: {
            select: {
              screenGeneration: true,
              providerRef: true,
              state: true,
              controlHolder: true,
              controlLeaseId: true,
              controlBotId: true,
              controlUserId: true,
              userId: true,
              controlLeaseExpiresAt: true,
            },
          },
        },
      });
      if (target.interactive && bot?.computer && !holdsUserControl(bot.computer, session.userId))
        return null;
      return bot?.computer;
    });
    if (
      !computer ||
      computer.screenGeneration !== scope.computerGeneration ||
      !computer.providerRef ||
      !["running", "booting", "suspending"].includes(computer.state) ||
      (target.interactive &&
        (!hasActiveComputerControl(computer) ||
          !scope.controlLeaseId ||
          computer.controlLeaseId !== scope.controlLeaseId ||
          computer.controlBotId !== scope.botId))
    )
      return c.body(null, 403);
    return c.json(target);
  });
}
