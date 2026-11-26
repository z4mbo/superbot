import { checkInSchedule, checkInTimingError } from "../../tasks/check-in-offer.js";
import { delegateTask, followUpTask, listTaskThreads, stopTask } from "../../tasks/task-threads.js";
import { createScheduleFromTool } from "../../tools/schedule-tools.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/**
 * Task threads and check-in offers. Every task-thread tool acts only on the threads this run's
 * conversation started, read on the server from the run itself, never from an id alone.
 */
export const taskThreadTools: ToolHandlers = {
  async delegate(ctx, call) {
    const { args } = call;
    return call.finish(
      await delegateTask(ctx, {
        brief: String(args.brief ?? ""),
        title: String(args.title ?? ""),
        executionId: call.executionId,
        effectKey: call.effectKey,
      }),
    );
  },
  async follow_up(ctx, call) {
    const { args } = call;
    return call.finish(
      await followUpTask(ctx, {
        threadId: String(args.threadId ?? ""),
        message: String(args.message ?? ""),
        executionId: call.executionId,
        effectKey: call.effectKey,
      }),
    );
  },
  async stop_task(ctx, call) {
    return call.finish(await stopTask(ctx, { threadId: String(call.args.threadId ?? "") }));
  },
  async link_to_thread(ctx, call) {
    return listTaskThreads(ctx, { query: String(call.args.query ?? "") });
  },
  /** Runs only once the person accepted the offer's card: the same save schedule_create makes. */
  async offer_check_in(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const timingError = checkInTimingError(call.args);
    if (timingError) return call.finish({ error: timingError });
    return call.finish(
      await createScheduleFromTool(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        threadId: thread.id,
        ...checkInSchedule(call.args),
      }),
    );
  },
};
