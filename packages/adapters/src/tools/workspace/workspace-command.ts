import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";

/** How long past a command's own timeout its transport is waited for before giving up on it. */
const COMMAND_GRACE_MS = 10_000;
/** A helper script's output is bounded by the script itself; this only guards against a fault. */
const OUTPUT_MAX_CHARS = 4_000_000;

export type WorkspaceCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Runs one argv on the bot's computer and collects its output. Arguments travel as argv, never as
 * a shell line. The command is stopped at `timeoutMs`; a transport that does not stop it then is
 * abandoned shortly after, so a slow or stuck command never holds the run.
 */
export async function runWorkspaceCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  request: CommandRequest & { timeoutMs: number },
  context: AdapterContext,
): Promise<WorkspaceCommandResult> {
  const signal = deadlineSignal(request.timeoutMs + COMMAND_GRACE_MS, context.signal);
  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    for await (const event of sandbox.execute(computer, request, { ...context, signal })) {
      if (event.type === "exit") code = event.code;
      else if (event.type === "stdout") {
        if (stdout.length < OUTPUT_MAX_CHARS) stdout += event.data;
      } else if (stderr.length < OUTPUT_MAX_CHARS) stderr += event.data;
    }
  } catch (error) {
    if (context.signal.aborted || !signal.aborted) throw error;
    return { code: 124, stdout, stderr, timedOut: true };
  }
  context.signal.throwIfAborted();
  // 124 is what the computer's own timeout wrapper exits with.
  return { code, stdout, stderr, timedOut: code === 124 || signal.aborted };
}
