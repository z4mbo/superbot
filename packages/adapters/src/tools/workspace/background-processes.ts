import { randomUUID } from "node:crypto";
import type { CommandRequest, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import { PROCESS_MANAGE_ACTIONS } from "../builtin-computer.tool-definition.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import { runWorkspaceCommand } from "./workspace-command.js";

/**
 * Background processes the bot starts with process_manage. Each one has a folder in a hidden
 * registry in the bot's own workspace folder, holding its pid, command, start time, working folder,
 * output log and exit code, so later calls and later runs on the same computer can find it. Only
 * processes recorded there can be checked or stopped, and only while the pid still names the
 * process that was started (its command line carries the process id), so a reused pid is never
 * signalled.
 */
export const PROCESS_REGISTRY = ".rakazo/processes";
const PROCESS_SCRIPT_TIMEOUT_MS = 30_000;
/** How much of a process's output check returns, from its end. */
export const PROCESS_OUTPUT_TAIL_BYTES = 4_000;
/** list shows the most recently started processes first, at most this many. */
const PROCESS_LIST_MAX = 20;
const PROCESS_ID = /^[0-9a-f]{12}$/;
const COMMAND_DISPLAY_MAX_CHARS = 200;

export type ProcessStatus = "running" | "exited" | "killed" | "stopped";

// The registry folder resolved to an absolute path, created on first use.
const REGISTRY_SCRIPT = 'mkdir -p -- "$1" && cd -- "$1" && pwd -P';

// Runs in the command's working folder. Everything after the four fixed arguments is the
// launcher, which receives the command as its last argument. Ignoring hangups lets the process
// outlive the call; its output goes to the log, and the exit code is written when it ends.
const START_SCRIPT = [
  "set -eu",
  'registry=$1; id=$2; started=$3; command=$4; shift 4',
  'dir="$registry/$id"',
  'mkdir -p -- "$dir"',
  // Finished processes older than a week are forgotten, logs and all.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'find "$registry" -mindepth 2 -maxdepth 2 \\( -name exit -o -name killed \\) -mtime +7 2>/dev/null | while IFS= read -r done_file; do rm -rf -- "${done_file%/*}"; done',
  'printf "%s" "$command" > "$dir/command"',
  'printf "%s" "$started" > "$dir/started"',
  'pwd > "$dir/cwd"',
  '( set +e; trap "" HUP; "$@" "$command" < /dev/null > "$dir/output.log" 2>&1; printf "%s\\n" "$?" > "$dir/exit" ) &',
  'printf "%s\\n" "$!" > "$dir/pid"',
  'printf "%s\\n" "$!"',
].join("\n");

// `ours PID ID` holds while PID is alive and its command line names ID, as the start subshell's
// does; a pid reused by another process does not.
const OURS = [
  "ours() {",
  '  [ -n "$1" ] && kill -0 "$1" 2>/dev/null && ps -ww -o args= -p "$1" 2>/dev/null | grep -F -q -e "$2"',
  "}",
].join("\n");

// One record per process: id, status, exit code, pid, start time, command, each NUL-terminated.
// With one id the output tail follows the record.
const STATUS_SCRIPT = [
  OURS,
  'registry=$1; tail_bytes=$2; shift 2',
  // Process ids are hex, so the listing splits safely.
  '[ "$#" -gt 0 ] || set -- $(ls -1 -- "$registry" 2>/dev/null)',
  'for id in "$@"; do',
  '  dir="$registry/$id"',
  '  [ -d "$dir" ] || continue',
  '  pid=$(cat "$dir/pid" 2>/dev/null || true)',
  '  code=$(cat "$dir/exit" 2>/dev/null || true)',
  '  if [ -e "$dir/killed" ]; then status=killed',
  '  elif [ -n "$code" ]; then status=exited',
  '  elif ours "$pid" "$id"; then status=running',
  "  else status=stopped",
  "  fi",
  '  printf "%s\\0%s\\0%s\\0%s\\0" "$id" "$status" "$code" "$pid"',
  '  cat "$dir/started" 2>/dev/null; printf "\\0"',
  '  cat "$dir/command" 2>/dev/null; printf "\\0"',
  '  [ "$tail_bytes" -gt 0 ] && tail -c "$tail_bytes" "$dir/output.log" 2>/dev/null',
  "done",
  "exit 0",
].join("\n");

// Stops a recorded process and everything it started: TERM first, KILL for what is left after
// about two seconds. Prints what it found: unknown, not-running or killed.
const KILL_SCRIPT = [
  OURS,
  'registry=$1; id=$2; dir="$registry/$id"',
  '[ -d "$dir" ] || { echo unknown; exit 0; }',
  'pid=$(cat "$dir/pid" 2>/dev/null || true)',
  'ours "$pid" "$id" || { echo not-running; exit 0; }',
  "tree() {",
  "  ps -A -o pid= -o ppid= | awk -v root=\"$1\" '",
  "    { parent[$1] = $2 }",
  "    END {",
  "      keep[root] = 1; grew = 1",
  "      while (grew) { grew = 0; for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; grew = 1 } }",
  "      for (p in keep) print p",
  "    }'",
  "}",
  'pids=$(tree "$pid")',
  ': > "$dir/killed"',
  "kill -TERM $pids 2>/dev/null",
  "tries=0",
  'while [ "$tries" -lt 20 ]; do',
  "  alive=",
  '  for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done',
  '  [ -z "$alive" ] && break',
  "  sleep 0.1",
  "  tries=$((tries + 1))",
  "done",
  '[ -n "$alive" ] && kill -KILL $alive 2>/dev/null',
  "echo killed",
].join("\n");

export type ProcessLaunch =
  /** The command runs in the user's own shell on a computer with a native shell. */
  | { kind: "native"; shell: string }
  /** The command runs through a launcher that keeps the computer awake while it runs. */
  | { kind: "launcher"; argv: string[] };

export function startProcessArgv(input: {
  registry: string;
  id: string;
  startedAt: string;
  command: string;
  launch: ProcessLaunch;
}): string[] {
  const launcher =
    input.launch.kind === "native" ? [input.launch.shell, "-lc"] : input.launch.argv;
  return [
    "sh",
    "-c",
    START_SCRIPT,
    "rakazo-process",
    input.registry,
    input.id,
    input.startedAt,
    input.command,
    ...launcher,
  ];
}

export function processStatusArgv(registry: string, ids: string[], tailBytes: number) {
  return ["sh", "-c", STATUS_SCRIPT, "rakazo-process-status", registry, String(tailBytes), ...ids];
}

export function killProcessArgv(registry: string, id: string) {
  return ["sh", "-c", KILL_SCRIPT, "rakazo-process-kill", registry, id];
}

type ProcessRecord = {
  id: string;
  status: ProcessStatus;
  exitCode?: number;
  pid?: number;
  startedAt?: string;
  command: string;
  output?: string;
};

/** Records printed by the status script; with one id, what follows the record is its output. */
export function parseProcessRecords(stdout: string, withOutput: boolean): ProcessRecord[] {
  const fields = stdout.split("\0");
  const records: ProcessRecord[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [id, status, code, pid, startedAt, command] = fields.slice(index, index + 6);
    if (!id || !PROCESS_ID.test(id)) break;
    const record: ProcessRecord = {
      id,
      status: (["running", "exited", "killed"].includes(status ?? "") ? status : "stopped") as ProcessStatus,
      command: command ?? "",
      ...(code && /^\d+$/.test(code.trim()) ? { exitCode: Number(code.trim()) } : {}),
      ...(pid && /^\d+$/.test(pid.trim()) ? { pid: Number(pid.trim()) } : {}),
      ...(startedAt ? { startedAt } : {}),
    };
    if (withOutput) {
      record.output = fields.slice(index + 6).join("\0");
      records.push(record);
      break;
    }
    records.push(record);
  }
  return records;
}

export type ProcessManageOptions = {
  /** How the command is launched; undefined where background processes are unavailable. */
  launch: ProcessLaunch | undefined;
  /** The command's working folder, as the shell tool resolves it. */
  cwd: string | undefined;
  /** Variables the shell tool would give the command. */
  env?: Pick<CommandRequest, "env" | "unsetEnv">;
  /** Called once the command was handed to the computer with its variables. */
  onStarted?: (id: string) => Promise<void>;
};

function displayCommand(command: string, secrets: string[]): string {
  const redacted = redactSecrets(command, secrets);
  return redacted.length > COMMAND_DISPLAY_MAX_CHARS
    ? `${redacted.slice(0, COMMAND_DISPLAY_MAX_CHARS)}…`
    : redacted;
}

/** start, list, check and kill for processes started through this tool. */
export async function processManageFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
  options: ProcessManageOptions,
) {
  const action = String(args.action ?? "");
  if (!(PROCESS_MANAGE_ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of ${PROCESS_MANAGE_ACTIONS.join(", ")}` };
  }
  if (!options.launch) {
    return { error: "background processes are unavailable on this computer; use shell" };
  }
  const { botId, computerMode, context, runSecrets } = workspace;
  const registry = resolveBotWorkspacePath(computerMode, botId, PROCESS_REGISTRY);
  const computer = await workspace.computer();
  const run = (argv: string[], extra: Partial<CommandRequest> = {}) =>
    runWorkspaceCommand(
      sandbox,
      computer,
      { argv, timeoutMs: PROCESS_SCRIPT_TIMEOUT_MS, ...extra },
      context,
    );
  const failed = (result: { stderr: string; timedOut: boolean }, fallback: string) =>
    new Error(
      result.timedOut
        ? "the computer did not answer in time"
        : redactSecrets(result.stderr.trim(), runSecrets) || fallback,
    );

  if (action === "start") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return { error: "command is required to start a process" };
    // The command runs in its own folder, so it needs the registry's absolute path.
    const located = await run(["sh", "-c", REGISTRY_SCRIPT, "rakazo-process-registry", registry]);
    const absolute = located.stdout.trim();
    if (located.code !== 0 || !absolute) throw failed(located, "could not prepare the process registry");
    const id = randomUUID().replaceAll("-", "").slice(0, 12);
    const startedAt = new Date().toISOString();
    workspace.markDirty();
    const started = await run(
      startProcessArgv({ registry: absolute, id, startedAt, command, launch: options.launch }),
      { cwd: options.cwd, ...options.env },
    );
    await options.onStarted?.(id);
    const pid = Number(started.stdout.trim());
    if (started.code !== 0 || !Number.isSafeInteger(pid)) throw failed(started, "could not start the process");
    return {
      id,
      status: "running" as const,
      pid,
      startedAt,
      command: displayCommand(command, runSecrets),
      note: "Check its output with action check and this id; stop it with action kill.",
    };
  }

  if (action === "list") {
    const listed = await run(processStatusArgv(registry, [], 0));
    if (listed.code !== 0) throw failed(listed, "could not list processes");
    const records = parseProcessRecords(listed.stdout, false).sort((a, b) =>
      (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
    );
    return {
      processes: records.slice(0, PROCESS_LIST_MAX).map((record) => ({
        ...record,
        command: displayCommand(record.command, runSecrets),
      })),
      ...(records.length > PROCESS_LIST_MAX ? { truncated: true } : {}),
    };
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!PROCESS_ID.test(id)) {
    return { error: "id must be a process id that action start or list returned" };
  }
  if (action === "kill") {
    const killed = await run(killProcessArgv(registry, id));
    const outcome = killed.stdout.trim();
    if (killed.code !== 0 || !outcome) throw failed(killed, "could not stop the process");
    if (outcome === "unknown") {
      return { error: "no process with this id was started with process_manage", id };
    }
    return outcome === "killed"
      ? { id, status: "killed" as const }
      : { id, status: "not running", note: "The process had already ended." };
  }

  const checked = await run(processStatusArgv(registry, [id], PROCESS_OUTPUT_TAIL_BYTES));
  if (checked.code !== 0) throw failed(checked, "could not check the process");
  const [record] = parseProcessRecords(checked.stdout, true);
  if (!record) return { error: "no process with this id was started with process_manage", id };
  return {
    ...record,
    command: displayCommand(record.command, runSecrets),
    output: redactSecrets(record.output ?? "", runSecrets),
  };
}

