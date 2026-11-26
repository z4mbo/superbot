import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { redactShellStreams } from "../../computers/sandbox/agent-environment.js";
import { runWorkspaceCommand } from "./workspace-command.js";

/** The languages execute_code runs. Python only: the standard computer image has no Node. */
export const EXECUTE_CODE_LANGUAGES = ["python"] as const;
/** The longest snippet accepted, in characters. It travels as one argument. */
export const EXECUTE_CODE_MAX_CHARS = 20_000;
export const EXECUTE_CODE_DEFAULT_TIMEOUT_SECONDS = 30;
/** The most a call may ask for; a longer job belongs in shell or process_manage. */
export const EXECUTE_CODE_MAX_TIMEOUT_SECONDS = 60;
/** The address space the interpreter may use, where the computer lets a process be limited. */
export const EXECUTE_CODE_MEMORY_LIMIT_KB = 2 * 1024 * 1024;
/** What the model reads of stdout and of stderr; the rest is cut with a marker. */
export const EXECUTE_CODE_OUTPUT_MAX_CHARS = 20_000;
/** The most of the last expression's value that is returned as `result`. */
export const EXECUTE_CODE_RESULT_MAX_CHARS = 4_000;
/** Python writes past this many characters per stream are dropped on the computer. */
const PYTHON_STREAM_CAP_CHARS = 1_000_000;
/** Read past the shown size before redacting, so a secret cut at the edge is still recognized. */
const REDACTION_MARGIN_CHARS = 4_000;
/** The wrapper's own work after the interpreter stops: cleanup and printing what it kept. */
const WRAPPER_GRACE_MS = 10_000;

/**
 * Runs the snippet inside the runner below, in a process group of its own with a memory limit
 * where the computer allows one, and stops that group (the interpreter and anything it started in
 * it) when the time is up. The snippet is written to a temporary file from an argument: it is never
 * part of this script's text. After the run, a boundary line and a JSON trailer report the exit
 * status, whether time ran out, and the runner's result; the temporary folder is removed.
 * Arguments: memory limit in KB (0 for none), seconds, boundary, Python stream cap, runner, code.
 */
export const EXECUTE_CODE_WRAPPER = [
  "set -u",
  'limit_kb=$1 seconds=$2 boundary=$3 cap=$4 runner=$5 code=$6 pid=""',
  // Errors of this script itself never reach the snippet's stderr.
  "exec 3>&2 2>/dev/null",
  "if ! command -v python3 >/dev/null; then",
  '  printf \'\\n%s\\n{"timedOut":false,"status":127,"missing":"python3"}\\n\' "$boundary"; exit 127',
  "fi",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell default, not a template.
  'dir=$(mktemp -d "${TMPDIR:-/tmp}/rakazo-code.XXXXXX") || exit 1',
  'cleanup() { if [ -n "$pid" ]; then kill -KILL -- "-$pid"; fi; rm -rf "$dir"; }',
  "trap cleanup EXIT",
  "trap 'exit 143' TERM INT HUP",
  'printf \'%s\' "$code" > "$dir/code.py"',
  // Job control gives each background job a process group of its own.
  "set -m",
  '( if [ "$limit_kb" != 0 ]; then ulimit -v "$limit_kb"; fi',
  '  exec python3 -u -c "$runner" "$dir/code.py" "$dir/result.json" "$cap" 2>&3 3>&- ) < /dev/null &',
  "pid=$!",
  '( sleep "$seconds"; : > "$dir/timed-out"; kill -KILL -- "-$pid" ) &',
  "watch=$!",
  'wait "$pid"; status=$?',
  'kill -KILL -- "-$watch"',
  // What the snippet started in its group and left running goes with it.
  'kill -KILL -- "-$pid"; pid=""',
  'timed=false; if [ -e "$dir/timed-out" ]; then timed=true; fi',
  'printf \'\\n%s\\n{"timedOut":%s,"status":%d}\\n\' "$boundary" "$timed" "$status"',
  'if [ -s "$dir/result.json" ]; then head -c 20000 "$dir/result.json"; fi',
  'if [ "$timed" = true ]; then exit 124; fi',
  'exit "$status"',
].join("\n");

/**
 * Runs the snippet as a script, and when its last statement is an expression, evaluates it as a
 * notebook cell does and saves its value: as JSON when it is a JSON value, else its repr. Writes
 * through print are capped per stream so a runaway loop cannot flood the computer.
 * Arguments: the code file, the result file, the per-stream cap.
 */
export const EXECUTE_CODE_PYTHON_RUNNER = [
  "import ast, json, sys, traceback",
  "path, result_path, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])",
  "class Capped:",
  "    def __init__(self, stream):",
  "        self.stream, self.left, self.dropped = stream, cap, 0",
  "    def write(self, text):",
  "        kept = text[:max(self.left, 0)]",
  "        if kept:",
  "            self.stream.write(kept)",
  "            self.left -= len(kept)",
  "        self.dropped += len(text) - len(kept)",
  "        return len(text)",
  "    def flush(self):",
  "        self.stream.flush()",
  "    def __getattr__(self, name):",
  "        return getattr(self.stream, name)",
  "out, err = Capped(sys.stdout), Capped(sys.stderr)",
  "sys.stdout, sys.stderr = out, err",
  "saved = {}",
  "def save():",
  "    saved.update(stdoutDropped=out.dropped, stderrDropped=err.dropped)",
  "    with open(result_path, 'w', encoding='utf-8') as file:",
  "        json.dump(saved, file)",
  "status = 0",
  "try:",
  "    with open(path, encoding='utf-8') as file:",
  "        tree = ast.parse(file.read(), '<code>')",
  "    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None",
  "    scope = {'__name__': '__main__', '__builtins__': __builtins__}",
  "    sys.argv = ['<code>']",
  "    exec(compile(tree, '<code>', 'exec'), scope)",
  "    if last is not None:",
  "        value = eval(compile(ast.Expression(last.value), '<code>', 'eval'), scope)",
  "        if value is not None:",
  "            try:",
  "                text = json.dumps(value)",
  "                saved['result'] = value if len(text) <= 4000 else None",
  "                if saved['result'] is None:",
  "                    saved['resultText'] = text[:4000]",
  "            except (TypeError, ValueError):",
  "                saved['resultText'] = repr(value)[:4000]",
  "except SystemExit as stop:",
  "    status = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)",
  "    if stop.code is not None and not isinstance(stop.code, int):",
  "        print(stop.code, file=sys.stderr)",
  "except BaseException as error:",
  "    status = 1",
  "    tb = error.__traceback__",
  "    while tb is not None and tb.tb_frame.f_code.co_filename != '<code>':",
  "        tb = tb.tb_next",
  "    traceback.print_exception(type(error), error, tb)",
  "finally:",
  "    sys.stdout.flush()",
  "    save()",
  "sys.exit(status)",
].join("\n");

export type ExecuteCodeInput = { language: "python"; code: string; timeoutSeconds: number };

/** An execute_code call as the computer runs it, or why it was refused before anything ran. */
export function parseExecuteCodeCall(
  args: Record<string, unknown>,
): ExecuteCodeInput | { error: string } {
  const language = args.language === undefined ? "python" : args.language;
  if (language !== "python")
    return { error: "execute_code runs python only; use shell for other languages" };
  if (typeof args.code !== "string" || !args.code.trim())
    return { error: "execute_code needs code: a Python snippet" };
  if (args.code.length > EXECUTE_CODE_MAX_CHARS)
    return {
      error: `execute_code code must be at most ${EXECUTE_CODE_MAX_CHARS} characters; write a file and run it with shell instead`,
    };
  const asked = args.timeout_seconds;
  if (asked !== undefined && (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0))
    return { error: "execute_code timeout_seconds must be a positive number" };
  const timeoutSeconds = Math.min(
    EXECUTE_CODE_MAX_TIMEOUT_SECONDS,
    Math.max(1, Math.ceil(asked ?? EXECUTE_CODE_DEFAULT_TIMEOUT_SECONDS)),
  );
  return { language: "python", code: args.code, timeoutSeconds };
}

/** The argv that runs a snippet: the code is the last argument, never part of a shell line. */
export function executeCodeArgv(input: {
  code: string;
  timeoutSeconds: number;
  boundary: string;
  memoryLimitKb?: number;
}): string[] {
  return [
    "bash",
    "-c",
    EXECUTE_CODE_WRAPPER,
    "rakazo-execute-code",
    String(input.memoryLimitKb ?? EXECUTE_CODE_MEMORY_LIMIT_KB),
    String(input.timeoutSeconds),
    input.boundary,
    String(PYTHON_STREAM_CAP_CHARS),
    EXECUTE_CODE_PYTHON_RUNNER,
    input.code,
  ];
}

type Trailer = {
  timedOut?: boolean;
  status?: number;
  missing?: string;
  result?: unknown;
  resultText?: string;
  stdoutDropped?: number;
  stderrDropped?: number;
};

/** The snippet's own stdout, and the wrapper's trailer after the last boundary line. */
export function splitExecuteCodeOutput(
  stdout: string,
  boundary: string,
): { stdout: string; trailer: Trailer | undefined } {
  const marker = `\n${boundary}\n`;
  const at = stdout.lastIndexOf(marker);
  if (at === -1) return { stdout, trailer: undefined };
  const [head = "", body = ""] = stdout.slice(at + marker.length).split("\n");
  const trailer: Trailer = {};
  try {
    Object.assign(trailer, JSON.parse(head));
    if (body.trim()) Object.assign(trailer, JSON.parse(body));
  } catch {
    // A snippet that printed the boundary itself only loses its own result.
  }
  return { stdout: stdout.slice(0, at), trailer };
}

function shown(text: string, dropped: number): { text: string; truncated: boolean } {
  const cut = Math.max(0, text.length - EXECUTE_CODE_OUTPUT_MAX_CHARS) + dropped;
  if (cut === 0) return { text, truncated: false };
  return {
    text: `${text.slice(0, EXECUTE_CODE_OUTPUT_MAX_CHARS)}\n…[${cut} characters cut]`,
    truncated: true,
  };
}

/** A JSON value with the run's secrets hidden; as text when hiding one breaks its JSON. */
function redactedValue(value: unknown, secrets: string[]): unknown {
  const text = JSON.stringify(value);
  const hidden = redactSecrets(text, secrets);
  if (hidden === text) return value;
  try {
    return JSON.parse(hidden);
  } catch {
    return hidden;
  }
}

export const NO_PYTHON_MESSAGE =
  "This computer has no python3, so nothing ran. Install it with shell, or use shell instead.";
export const WINDOWS_MESSAGE =
  "execute_code needs a Linux or macOS computer; on Windows use shell instead.";

export type ExecuteCodeResult =
  | {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
      result?: unknown;
      truncated?: true;
    }
  | { error: string };

/**
 * Runs one snippet on the computer and reports what it printed, its exit code, whether its time
 * ran out and its last expression's value, each redacted with the run's secrets and cut to size.
 */
export async function executeCode(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  input: ExecuteCodeInput,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    unsetEnv?: string[];
    secrets: () => string[];
    memoryLimitKb?: number;
  },
  context: AdapterContext,
): Promise<ExecuteCodeResult> {
  const boundary = `rakazo-execute-code-${randomUUID()}`;
  const ran = await runWorkspaceCommand(
    sandbox,
    computer,
    {
      argv: executeCodeArgv({ ...input, boundary, memoryLimitKb: options.memoryLimitKb }),
      cwd: options.cwd,
      env: options.env,
      unsetEnv: options.unsetEnv,
      timeoutMs: input.timeoutSeconds * 1000 + WRAPPER_GRACE_MS,
    },
    context,
  );
  const { stdout, trailer } = splitExecuteCodeOutput(ran.stdout, boundary);
  if (trailer?.missing) return { error: NO_PYTHON_MESSAGE };
  const secrets = options.secrets();
  // Redacted with a margin past the shown size, then cut: a cut never leaves part of a secret.
  const safe = redactShellStreams(
    {
      stdout: stdout.slice(0, EXECUTE_CODE_OUTPUT_MAX_CHARS + REDACTION_MARGIN_CHARS),
      stderr: ran.stderr.slice(0, EXECUTE_CODE_OUTPUT_MAX_CHARS + REDACTION_MARGIN_CHARS),
    },
    secrets,
  );
  const out = shown(
    safe.stdout,
    Math.max(0, stdout.length - EXECUTE_CODE_OUTPUT_MAX_CHARS - REDACTION_MARGIN_CHARS) +
      (trailer?.stdoutDropped ?? 0),
  );
  const err = shown(
    safe.stderr,
    Math.max(0, ran.stderr.length - EXECUTE_CODE_OUTPUT_MAX_CHARS - REDACTION_MARGIN_CHARS) +
      (trailer?.stderrDropped ?? 0),
  );
  const timedOut = trailer?.timedOut === true || ran.timedOut;
  const value =
    trailer && "result" in trailer && trailer.result !== null
      ? redactedValue(trailer.result, secrets)
      : typeof trailer?.resultText === "string"
        ? redactSecrets(trailer.resultText, secrets).slice(0, EXECUTE_CODE_RESULT_MAX_CHARS)
        : undefined;
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: timedOut ? null : (trailer?.status ?? ran.code),
    timedOut,
    ...(value !== undefined ? { result: value } : {}),
    ...(out.truncated || err.truncated ? { truncated: true as const } : {}),
  };
}
