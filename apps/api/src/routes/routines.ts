import { ORPCError } from "@orpc/server";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import {
  hasCheckedAppEvent,
  listAppEventSources,
  parseRoutineWatch,
  postRoutineNotice,
  RoutineWatchError,
  releaseRoutineAppEventsIn,
  routineEditChange,
  routineEdited,
  saveRoutineAppEventsIn,
  settleRoutineAppEvents,
  stableStringify,
  validateRoutineWatch,
  wakeRun,
} from "@rakazo/adapters";
import type { Actor, RoutineWatch } from "@rakazo/contracts";
import { canonicalPiProviderId, ROUTINE_TRIGGER_REQUIRED } from "@rakazo/contracts";
import {
  ClientError,
  expandSkillReferencesInPrompt,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
} from "@rakazo/core";
import { IsolationError, isRecordNotFound, Prisma } from "@rakazo/db";
import { assertRoutineModel } from "../bots/model-pins.js";
import { assertEmailTrigger } from "../email/bot-email-address.js";
import { listRoutineRuns } from "../routines/routine-runs.js";
import {
  assertRoutineSchedule,
  CHECKED_APP_EVENT_CONFLICT,
  createRoutineTestRun,
  firstWatchCheck,
  listRoutinesDto,
  nextRoutineDate,
  resolveAppEvents,
  routineNextRunAt,
  routineRowData,
  routineTestRunNonce,
  routineTestTarget,
  routineView,
  routineViews,
} from "../routines/routines.js";
import type { RouterContext } from "./context.js";

/** A watch the caller wrote that cannot be checked is theirs to fix; anything else is a fault. */
async function assertRoutineWatch(
  watch: RoutineWatch,
  actor: Actor,
  bot: { id: string; computer?: { scope: string } | null },
): Promise<void> {
  await validateRoutineWatch({}, watch, { ...actor, botId: bot.id }, bot.computer).catch(
    (error: unknown) => {
      if (error instanceof RoutineWatchError) throw new ClientError("BAD_REQUEST", error.message);
      throw error;
    },
  );
}

export function routinesRoutes(ctx: RouterContext) {
  const { deps, repos, announceRoutine, codexCatalog, agentSkills, authed } = ctx;
  return {
    routines: {
      listForMentions: authed.routines.listForMentions.handler(async ({ context, input }) => {
        const { actor } = context;
        // Same ownership predicates as getBot, so a batch never widens what routines/list allows.
        const bots = await deps.prisma.bot.findMany({
          where: {
            id: { in: input.botIds },
            spaceId: actor.spaceId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const rows = await deps.prisma.routine.findMany({
          where: { botId: { in: bots.map((bot) => bot.id) }, spaceId: actor.spaceId },
        });
        const views = await routineViews(deps, actor, rows, { appEvents: false });
        return bots.map((bot) => ({
          botId: bot.id,
          routines: views.filter((routine) => routine.botId === bot.id),
        }));
      }),
      appEventSources: authed.routines.appEventSources.handler(({ context }) =>
        listAppEventSources(deps, context.actor),
      ),
      history: authed.routines.history.handler(async ({ context, input }) =>
        listRoutineRuns(deps.prisma, context.actor, input.routineId, input.before, input.limit),
      ),
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        assertRoutineSchedule(input);
        const bot = await repos.getBot(context.actor, input.botId);
        if (input.watch) await assertRoutineWatch(input.watch, context.actor, bot);
        if (input.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        await assertRoutineModel(deps, context.actor, input, codexCatalog);
        const appEvents = await resolveAppEvents(deps, context.actor, bot, input.appEvents);
        if (appEvents.watch && (input.watch || input.crons.length > 0)) {
          throw new ClientError("BAD_REQUEST", CHECKED_APP_EVENT_CONFLICT);
        }
        const saved = { ...input, watch: input.watch ?? appEvents.watch };
        const { row, releases } = await deps.prisma.$transaction(async (tx) => {
          const row = await tx.routine.create({
            data: routineRowData(context.actor, saved, routineNextRunAt(saved)),
          });
          const releases = await saveRoutineAppEventsIn(tx, deps.jobs, row, appEvents.events);
          return { row, releases };
        });
        await settleRoutineAppEvents(deps, appEvents.events.length ? row.id : null, releases);
        await announceRoutine(context.actor, bot, row);
        await postRoutineNotice(deps, {
          spaceId: context.actor.spaceId,
          threadId: row.threadId ?? bot.thread?.id,
          botId: bot.id,
          change: "created",
          name: row.name,
        });
        return await routineView(deps, context.actor, row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        // Archived bots keep their routines paused, so resolve an active parent before any write.
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            bot: { archivedAt: null },
          },
        });
        if (!existing) throw new ORPCError("NOT_FOUND");
        // A routine runs with its owner's accounts, so only they change what it does. Anyone in
        // the Space may still turn it on or off, which keeps it theirs.
        if (existing.userId !== context.actor.userId) {
          const { routineId: _routineId, active: _active, ...changes } = input;
          if (Object.values(changes).some((value) => value !== undefined)) {
            throw new ClientError("FORBIDDEN", "Only the routine's owner can change it.");
          }
        }
        const bot = await repos.getBot(context.actor, existing.botId);
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
        const messageProvider =
          input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
        const emailSenders =
          input.emailSenders === undefined ? existing.emailSenders : input.emailSenders;
        if (input.emailSenders && input.emailSenders !== existing.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        const modelProvider =
          input.modelProvider === undefined ? existing.modelProvider : input.modelProvider;
        const modelId = input.modelId === undefined ? existing.modelId : input.modelId;
        const hasModel = Boolean(modelProvider && modelId);
        const modelChanged =
          canonicalPiProviderId(modelProvider ?? "") !==
            canonicalPiProviderId(existing.modelProvider ?? "") || modelId !== existing.modelId;
        const touchesModel =
          input.modelProvider !== undefined ||
          input.modelId !== undefined ||
          input.thinkingLevel !== undefined;
        if (Boolean(modelProvider) !== Boolean(modelId)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Model provider and model id must both be set or both cleared",
          });
        }
        if (input.thinkingLevel && !hasModel) {
          throw new ORPCError("BAD_REQUEST", { message: "Pick a model for this routine first" });
        }
        // A thinking level belongs to a model, so changing the model resets it.
        const thinkingLevel = !hasModel
          ? null
          : input.thinkingLevel === undefined
            ? modelChanged
              ? null
              : existing.thinkingLevel
            : input.thinkingLevel;
        if (modelChanged) {
          await assertRoutineModel(deps, context.actor, { modelProvider, modelId }, codexCatalog);
        }
        const appEvents =
          input.appEvents === undefined
            ? undefined
            : await resolveAppEvents(deps, context.actor, bot, input.appEvents);
        // An app event its provider doesn't push is the routine's change check; a change trigger
        // the owner set is theirs. The routine holds one.
        const checkedBefore = await hasCheckedAppEvent(deps.prisma, existing.id);
        const ownWatch =
          input.watch !== undefined
            ? input.watch
            : checkedBefore
              ? null
              : parseRoutineWatch(existing.watch);
        const checkedWatch = appEvents
          ? appEvents.watch
          : checkedBefore
            ? parseRoutineWatch(existing.watch)
            : null;
        if (ownWatch && checkedWatch) {
          throw new ClientError("BAD_REQUEST", CHECKED_APP_EVENT_CONFLICT);
        }
        const watchInput =
          input.watch !== undefined || appEvents !== undefined
            ? (ownWatch ?? checkedWatch)
            : undefined;
        const watch = watchInput === undefined ? parseRoutineWatch(existing.watch) : watchInput;
        if (input.watch) await assertRoutineWatch(input.watch, context.actor, bot);
        const watchChanged =
          watchInput !== undefined &&
          stableStringify(watchInput) !== stableStringify(parseRoutineWatch(existing.watch));
        const appEventCount =
          appEvents?.events.length ??
          (await deps.prisma.routineAppEvent.count({ where: { routineId: existing.id } }));
        if (
          crons.length === 0 &&
          !webhookEnabled &&
          !githubEnabled &&
          !messageProvider &&
          !emailSenders &&
          !watch &&
          appEventCount === 0
        ) {
          throw new ORPCError("BAD_REQUEST", { message: ROUTINE_TRIGGER_REQUIRED });
        }
        if (checkedWatch && crons.length > 0) {
          throw new ClientError("BAD_REQUEST", CHECKED_APP_EVENT_CONFLICT);
        }
        if (watch && crons.length > 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A change trigger checks on its own interval; remove the schedule",
          });
        }
        if (hasMixedOneShotSchedule(crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (active && isOneShotRoutineCrons(crons)) {
          if (!isOneShotRoutineCrons(existing.crons)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt && existing.lastRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "This one-shot already ran.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.crons !== undefined &&
            JSON.stringify(input.crons) !== JSON.stringify(existing.crons)) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(crons, timezone)
            : null;
        let armedOneShotAt: Date | null = null;
        if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
          if (!input.runAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Add a run time for this one-shot.",
            });
          }
          const parsed = new Date(input.runAt);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Run time must be in the future.",
            });
          }
          armedOneShotAt = parsed;
        } else if (input.runAt !== undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A run time is only for one-shots that have not run yet.",
          });
        }
        const nextRunAt = !active
          ? null
          : watch
            ? // Turning a watch on, or changing it, checks right away; otherwise keep its rhythm.
              !existing.active || watchChanged || !existing.nextRunAt
              ? firstWatchCheck()
              : existing.nextRunAt
            : crons.length === 0
              ? null
              : isOneShotRoutineCrons(crons)
                ? (armedOneShotAt ?? existing.nextRunAt)
                : (recalculatedNextRunAt ?? existing.nextRunAt);
        const writesSchedule = nextRunAt?.getTime() !== existing.nextRunAt?.getTime();
        // An explicit on/off must not undo an enable, a disable or a finished one-shot that landed
        // after the read; neither may a schedule change computed from the old on/off state.
        const writesActive = input.active !== undefined || scheduleChanged || watchChanged;
        // Re-check the parent in the write itself so an archive that lands after the read wins.
        // Model and schedule patches must also match the snapshot they were computed from, so a
        // tick that fired after the read is not rewound onto an occurrence that already ran.
        const { row, releases } = await deps.prisma.$transaction(async (tx) => {
          const row = await tx.routine
            .update({
              where: {
                id: existing.id,
                bot: { archivedAt: null },
                // Optimistic fence: every write must match the snapshot it was
                // computed from, so concurrent edits never silently overwrite
                // each other's prompt/name/notify/any other field.
                updatedAt: existing.updatedAt,
                ...(touchesModel
                  ? {
                      modelProvider: existing.modelProvider,
                      modelId: existing.modelId,
                      thinkingLevel: existing.thinkingLevel,
                    }
                  : {}),
                ...(writesSchedule ? { nextRunAt: existing.nextRunAt } : {}),
                ...(writesActive ? { active: existing.active } : {}),
              },
              data: {
                name: input.name,
                prompt: input.prompt,
                crons: input.crons,
                timezone: input.timezone,
                active: input.active,
                // An explicit on or off is the member's own choice, so a restore must not undo it.
                ...(input.active !== undefined ? { resumeOnRestore: false } : {}),
                notify: input.notify,
                // What a watch read is not the owner's words, so it never runs as a turn in the chat.
                inChat: watch ? false : input.inChat,
                webhookEnabled: input.webhookEnabled,
                githubEnabled: input.githubEnabled,
                messageProvider: input.messageProvider,
                emailSenders: input.emailSenders,
                ...(touchesModel ? { modelProvider, modelId, thinkingLevel } : {}),
                // A changed watch starts from a fresh baseline.
                ...(watchInput === undefined
                  ? {}
                  : { watch: (watchInput as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
                ...(watchChanged ? { watchState: Prisma.DbNull } : {}),
                ...(writesSchedule ? { nextRunAt } : {}),
              },
            })
            .catch(async (error: unknown) => {
              if (isRecordNotFound(error)) {
                if (
                  await deps.prisma.routine.findFirst({
                    where: {
                      id: existing.id,
                      spaceId: context.actor.spaceId,
                      bot: { archivedAt: null },
                    },
                    select: { id: true },
                  })
                ) {
                  throw new ClientError("CONFLICT", "Routine changed; retry.");
                }
                throw new ClientError("NOT_FOUND", "Not Found");
              }
              throw error;
            });
          const releases = await saveRoutineAppEventsIn(tx, deps.jobs, row, appEvents?.events, {
            syncNeeded: existing.active !== row.active,
          });
          return { row, releases };
        });
        await settleRoutineAppEvents(
          deps,
          appEvents !== undefined || existing.active !== row.active ? row.id : null,
          releases,
        );
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.updated",
            payload: { routineId: row.id, active: row.active },
          });
        }
        const scheduleNeedsSync =
          existing.active !== row.active ||
          scheduleChanged ||
          watchChanged ||
          existing.nextRunAt?.getTime() !== row.nextRunAt?.getTime() ||
          (!existing.nextRunAt && !!row.nextRunAt);
        if (scheduleNeedsSync) {
          if (row.active && row.nextRunAt) {
            await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
          } else {
            await deps.jobs.cancel(routineJobKey(row.id));
          }
        }
        if (routineEdited(existing, row)) {
          await postRoutineNotice(deps, {
            spaceId: context.actor.spaceId,
            threadId: existing.threadId ?? bot.thread?.id,
            botId: bot.id,
            change: routineEditChange(existing, row),
            name: row.name,
          });
        }
        return await routineView(deps, context.actor, row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        // Any member can delete a routine, as they can turn it off.
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
          include: { appEvents: { where: { handle: { not: null } }, select: { id: true } } },
        });
        if (!existing) throw new IsolationError();
        // Its subscriptions go with it: their release jobs commit with the delete.
        if (existing.appEvents?.length) {
          const releases = await deps.prisma.$transaction(async (tx) => {
            const releases = await releaseRoutineAppEventsIn(tx, deps.jobs, existing);
            await tx.routine.delete({ where: { id: existing.id } });
            return releases;
          });
          await settleRoutineAppEvents(deps, null, releases);
        } else {
          await deps.prisma.routine.delete({ where: { id: existing.id } });
        }
        await deps.jobs.cancel(routineJobKey(existing.id));
        await postRoutineNotice(deps, {
          spaceId: context.actor.spaceId,
          threadId: existing.threadId,
          botId: existing.botId,
          change: "deleted",
          name: existing.name,
        });
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const target = await routineTestTarget(deps.prisma, repos, context.actor, input.routineId);
        const { threadId } = target;
        const nonce = input.clientNonce
          ? routineTestRunNonce(context.actor, input.clientNonce)
          : undefined;
        const findExisting = async () =>
          nonce
            ? deps.prisma.run.findFirst({
                where: { threadId, userId: context.actor.userId, clientNonce: nonce },
                select: { id: true },
              })
            : null;
        const existing = await findExisting();
        if (existing) return { runId: existing.id };
        const skillRecords = await agentSkills.listWithContent(context.actor);
        const prompt = expandSkillReferencesInPrompt(target.routine.prompt, skillRecords);
        let run: { id: string };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            const existing = nonce
              ? await tx.run.findFirst({
                  where: { threadId, clientNonce: nonce },
                  select: { id: true },
                })
              : null;
            return existing ?? createRoutineTestRun(tx, context.actor, target, prompt, nonce);
          });
        } catch (error) {
          const existing = await findExisting();
          if (existing) return { runId: existing.id };
          throw error;
        }
        await wakeRun(deps.jobs, run.id);
        return { runId: run.id };
      }),
    },
  };
}
