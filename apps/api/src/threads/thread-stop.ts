import type { SandboxProvider } from "@rakazo/adapter-kit";
import { cancelThreadRuns, finishThreadStop } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { parseMessagingCommand } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

// Stop's two halves live with the run lifecycle, where a bot's stop_task uses them too.
export {
  cancelThreadRuns,
  finishThreadStop,
  STOPPED_BY_MESSAGE_NOTE,
  stoppedRoutineNote,
} from "@rakazo/adapters";

/** A bare "stop" or "stop now" with nothing attached: the owner's Stop, sent as text. */
export function isStopMessage(input: { text?: string; artifactIds?: string[] }) {
  return !input.artifactIds?.length && parseMessagingCommand(input.text ?? "") === "stop";
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  target: ThreadTarget,
  /** Stop only the background helper behind this card in the chat. */
  helperMessageId?: string,
) {
  const stop = await deps.prisma.$transaction(
    cancelThreadRuns(actor, target, undefined, helperMessageId),
    THREAD_LOCK_TRANSACTION_OPTIONS,
  );
  await finishThreadStop(deps, actor, target, stop);
}
