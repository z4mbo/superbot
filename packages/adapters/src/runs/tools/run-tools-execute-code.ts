import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { sandboxKindCapabilities } from "../../computers/sandbox/sandbox-kind-capabilities.js";
import { resolveBotWorkspaceCwd } from "../../computers/screens/computer-support.js";
import {
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  protectedCodeRefusal,
} from "../../providers/computer/desktop/desktop-command-guard.js";
import { shellCommandEnvironment } from "../../secrets/bot-secrets.js";
import {
  executeCode,
  parseExecuteCodeCall,
  WINDOWS_MESSAGE,
} from "../../tools/workspace/execute-code.js";
import type { RunContext } from "../assembly/run-context.js";
import { addRunSecrets, recordVaultUse } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { appendComputerCommand } from "./run-tools-computer.js";

/** How a snippet reads in the terminal's Activity view: as the heredoc a person would type. */
function activityCommand(code: string, secrets: string[]): string {
  return redactSecrets(`python3 - <<'EOF'\n${code}\nEOF`, secrets);
}

/**
 * execute_code: one short Python snippet on the bot's computer, inside the same boundary as shell,
 * with the same command variables, guard, activity record and redaction. It never runs in this
 * process.
 */
export async function executeCodeTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  const { name, args, executionId } = call;
  const input = parseExecuteCodeCall(args);
  if ("error" in input) return call.finish({ error: input.error });
  const refusal = protectedCodeRefusal(input.code);
  if (desktopGuardApplies(ctx.computer) && refusal)
    return call.finish({ error: desktopProtectionGuardMessage(refusal, input.code) });
  const computer = await ctx.computer.get("tool", name);
  const hostShell =
    ctx.computer.hostEnvironment ??
    (sandboxKindCapabilities(computer.kind).nativeShell
      ? await deps.sandbox.environment?.(computer, context)
      : undefined);
  if (hostShell?.platform === "win32") return call.finish({ error: WINDOWS_MESSAGE });
  const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, undefined);
  // The variables shell gives a command, registered for redaction before anything runs.
  const commandEnvironment = await shellCommandEnvironment({
    prisma: deps.prisma,
    secretStore: deps.secretStore,
    scope: run,
    registerRedactions: (values) => addRunSecrets(ctx, values),
    keyOutage: "unset",
  });
  ctx.computer.checkpoint.markDirty();
  const commandEvent = {
    executionId,
    kind: "shell" as const,
    command: activityCommand(input.code, ctx.secrets),
    cwd: redactSecrets(cwd ?? ".", ctx.secrets),
  };
  await appendComputerCommand(ctx, {
    ...commandEvent,
    status: "running",
    exitCode: null,
    output: "",
  });
  try {
    const result = await executeCode(
      deps.sandbox,
      computer,
      input,
      {
        cwd,
        env: Object.keys(commandEnvironment.env).length > 0 ? commandEnvironment.env : undefined,
        unsetEnv: commandEnvironment.unsetEnv,
        secrets: () => [...ctx.secrets],
      },
      context,
    ).finally(async () => {
      for (const item of commandEnvironment.used) await recordVaultUse(ctx, name, item);
    });
    await appendComputerCommand(ctx, {
      ...commandEvent,
      status: "done",
      exitCode: "error" in result ? 127 : (result.exitCode ?? 124),
      output: ("error" in result ? result.error : `${result.stdout}${result.stderr}`).slice(
        -COMPUTER_COMMAND_OUTPUT_MAX_CHARS,
      ),
    });
    return call.finish(result);
  } catch (error) {
    await appendComputerCommand(ctx, {
      ...commandEvent,
      status: "done",
      exitCode: 1,
      output: redactSecrets(
        error instanceof Error ? error.message : "code failed",
        ctx.secrets,
      ).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
    });
    throw error;
  }
}
