import path from "node:path";
import type { ComputerFileEntry, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import {
  displayBotWorkspacePath,
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
  WorkspacePathError,
} from "../../computers/screens/computer-support.js";
import { TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import {
  GLOB_DEFAULT_RESULTS,
  GLOB_MAX_RESULTS,
  SEARCH_FILES_DEFAULT_MATCHES,
  SEARCH_FILES_MAX_MATCHES,
} from "../builtin-computer.tool-definition.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import { positiveIntegerArg } from "../workspace-file-tools.js";
import { runWorkspaceCommand } from "./workspace-command.js";

/** A user's pattern runs in the computer, never in this process, and is stopped after this. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** A matching line is cut to this many characters in the result. */
const MATCH_TEXT_MAX_CHARS = 200;
/** glob lists at most this many files before matching, and says so when it stops there. */
export const GLOB_SCAN_MAX_FILES = 20_000;
/** On a computer with its own native shell, glob walks at most this many folders. */
const GLOB_WALK_MAX_FOLDERS = 2_000;
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

const SEARCH_SCRIPT = [
  'pattern=$1; target=$2; lines=$(($3 + 1)); ignore_case=$4; shift 4',
  // The path must stay in the workspace once links are resolved.
  "root=$(pwd -P) || exit 3",
  'real=$(realpath -e -- "$target" 2>/dev/null) || exit 3',
  'case "$real" in "$root" | "$root"/*) ;; *) exit 4 ;; esac',
  "if command -v rg >/dev/null 2>&1; then",
  "  case_flag=--case-sensitive",
  '  [ "$ignore_case" = 1 ] && case_flag=--ignore-case',
  '  error=$(rg "$case_flag" -- "$pattern" /dev/null 2>&1 >/dev/null)',
  '  if [ $? -eq 2 ]; then printf "%s\\n" "$error" >&2; exit 2; fi',
  "  flags=(--no-heading --with-filename --line-number --null --color never --no-messages --sort path --max-columns 1000 --max-columns-preview -g '!node_modules')",
  '  for name in "$@"; do flags+=(-g "$name"); done',
  '  rg "${flags[@]}" "$case_flag" -- "$pattern" "$target" | cut -c-2000 | head -n "$lines"',
  "  exit 0",
  "fi",
  "flags=(-nHIE --null)",
  '[ "$ignore_case" = 1 ] && flags+=(-i)',
  'error=$(grep "${flags[@]}" -- "$pattern" /dev/null 2>&1 >/dev/null)',
  'if [ $? -eq 2 ]; then printf "%s\\n" "$error" >&2; exit 2; fi',
  'if [ ! -d "$target" ]; then',
  '  grep "${flags[@]}" -- "$pattern" "$target" 2>/dev/null | cut -c-2000 | head -n "$lines"',
  "  exit 0",
  "fi",
  "names=()",
  'for name in "$@"; do',
  '  [ ${#names[@]} -gt 0 ] && names+=(-o)',
  '  names+=(-name "$name")',
  "done",
  '[ ${#names[@]} -gt 0 ] && names=("(" "${names[@]}" ")")',
  "find \"$target\" -mindepth 1 '(' -name '.?*' -o -name node_modules ')' -prune -o -type f \"${names[@]}\" -print0 2>/dev/null |",
  '  sort -z | xargs -0 -r grep "${flags[@]}" -- "$pattern" 2>/dev/null | cut -c-2000 | head -n "$lines"',
].join("\n");

const GLOB_SCRIPT = [
  'target=$1; lines=$(($2 + 1)); hidden=$3',
  "root=$(pwd -P) || exit 3",
  'real=$(realpath -e -- "$target" 2>/dev/null) || exit 3',
  'case "$real" in "$root" | "$root"/*) ;; *) exit 4 ;; esac',
  '[ -d "$target" ] || exit 5',
  // Hidden folders are pruned too when the pattern could never match inside one.
  "skip=(-name .git -o -name node_modules)",
  "[ \"$hidden\" = 1 ] || skip+=(-o -name '.?*')",
  "cd -- \"$target\" && find . -mindepth 1 '(' \"${skip[@]}\" ')' -prune -o -type f -print0 2>/dev/null |",
  '  sort -z | head -z -n "$lines" | tr "\\0" "\\n"',
].join("\n");

/** The search script's argv: patterns and paths are arguments, never shell text. */
export function searchCommandArgv(input: {
  pattern: string;
  target: string;
  limit: number;
  ignoreCase: boolean;
  names: string[];
}): string[] {
  return [
    "bash",
    "-c",
    SEARCH_SCRIPT,
    "rakazo-search",
    input.pattern,
    input.target,
    String(input.limit),
    input.ignoreCase ? "1" : "0",
    ...input.names,
  ];
}

export function globCommandArgv(input: { target: string; limit: number; hidden: boolean }) {
  return [
    "bash",
    "-c",
    GLOB_SCRIPT,
    "rakazo-glob",
    input.target,
    String(input.limit),
    input.hidden ? "1" : "0",
  ];
}

/** `{a,b}` alternatives expanded, for tools that match one plain name pattern at a time. */
export function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const head = pattern.slice(0, match.index);
  const tail = pattern.slice(match.index + match[0].length);
  return [...new Set(match[1]!.split(",").flatMap((part) => expandBraces(head + part + tail)))];
}

function clampedLimit(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveIntegerArg(value) ?? fallback, max);
}

/** The searched path relative to the workspace root, as the computer's commands see it. */
function searchTarget(workspace: RunWorkspace, requested: string): string {
  const stored = resolveBotWorkspacePath(workspace.computerMode, workspace.botId, requested);
  return normalizeWorkspacePath(stored) || ".";
}

/** A path a command printed, as the model names it. */
function displayPath(workspace: RunWorkspace, requested: string, printed: string): string {
  const stored = normalizeWorkspacePath(printed.replace(/^\.\//, ""));
  return redactSecrets(
    displayBotWorkspacePath(workspace.computerMode, workspace.botId, requested, stored),
    workspace.runSecrets,
  );
}

function pathError(code: number, requested: string): { error: string; path: string } | undefined {
  if (code === 3) return { error: "no such file or folder", path: requested };
  if (code === 4) return { error: "the path leaves the workspace", path: requested };
  if (code === 5) return { error: "the path is not a folder", path: requested };
  return undefined;
}

/** Drops results from the end until the serialized result fits the tool result limit. */
function fitResult<T>(items: T[], build: (items: T[], cut: boolean) => object): object {
  let count = items.length;
  let result = build(items, false);
  while (count > 0 && JSON.stringify(result).length > TOOL_RESULT_TEXT_LIMIT) {
    count = Math.max(0, Math.min(count - 1, Math.floor(count * 0.9)));
    result = build(items.slice(0, count), true);
  }
  return result;
}

type SearchMatch = { file: string; line: number; text: string };

/** Content search on the bot's computer with ripgrep, or grep where ripgrep is missing. */
export async function searchFilesFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
  options: { nativeShell: boolean },
) {
  const requested = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return { error: "pattern is required" };
  if (options.nativeShell) {
    return {
      error:
        "search_files is unavailable on this computer; search with shell using its own tools",
    };
  }
  const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
  if (glob?.includes("/")) {
    return { error: "glob matches file names only, such as *.ts; put folders in path" };
  }
  const limit = clampedLimit(args.max_matches, SEARCH_FILES_DEFAULT_MATCHES, SEARCH_FILES_MAX_MATCHES);
  let target: string;
  try {
    target = searchTarget(workspace, requested);
  } catch (error) {
    if (error instanceof WorkspacePathError) return { error: error.message, path: requested };
    throw error;
  }
  const result = await runWorkspaceCommand(
    sandbox,
    await workspace.computer(),
    {
      argv: searchCommandArgv({
        pattern,
        target,
        limit,
        ignoreCase: args.case_sensitive === false,
        names: glob ? expandBraces(glob) : [],
      }),
      timeoutMs: SEARCH_TIMEOUT_MS,
    },
    workspace.context,
  );
  if (result.timedOut) {
    return {
      error: `search stopped after ${SEARCH_TIMEOUT_MS / 1000} seconds; narrow path or glob`,
      path: requested,
    };
  }
  const refused = pathError(result.code, requested);
  if (refused) return refused;
  if (result.code === 2) {
    const reason = redactSecrets(result.stderr.trim(), workspace.runSecrets).slice(0, 300);
    return { error: `invalid pattern${reason ? `: ${reason}` : ""}`, path: requested };
  }
  if (result.code !== 0) {
    throw new Error(
      redactSecrets(result.stderr.trim(), workspace.runSecrets) || "could not search files",
    );
  }
  const matches: SearchMatch[] = [];
  for (const row of result.stdout.split("\n")) {
    const separator = row.indexOf("\0");
    if (separator <= 0) continue;
    const found = /^(\d+):(.*)$/s.exec(row.slice(separator + 1));
    if (!found) continue;
    const text = redactSecrets(found[2]!, workspace.runSecrets);
    matches.push({
      file: displayPath(workspace, requested, row.slice(0, separator)),
      line: Number(found[1]),
      text: text.length > MATCH_TEXT_MAX_CHARS ? `${text.slice(0, MATCH_TEXT_MAX_CHARS)}…` : text,
    });
  }
  const overLimit = matches.length > limit;
  return fitResult(matches.slice(0, limit), (shown, cut) => ({
    path: requested,
    pattern,
    matches: shown,
    truncated: overLimit || cut,
  }));
}

/** Lists files under `target` with the computer's file API, for computers without find. */
async function walkFiles(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  target: string,
  hidden: boolean,
): Promise<{ files: string[]; complete: boolean }> {
  const computer = await workspace.computer();
  const files: string[] = [];
  const folders = [target === "." ? "" : target];
  let visited = 0;
  while (folders.length) {
    if (visited >= GLOB_WALK_MAX_FOLDERS || files.length >= GLOB_SCAN_MAX_FILES) {
      return { files: files.sort(), complete: false };
    }
    const folder = folders.shift()!;
    visited += 1;
    let entries: ComputerFileEntry[];
    try {
      entries = await sandbox.listFiles(computer, folder, workspace.context);
    } catch (error) {
      if (visited === 1) throw error;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const name = path.posix.basename(entry.path);
      if (entry.kind === "dir") {
        if (!SKIPPED_FOLDERS.has(name) && (hidden || !name.startsWith("."))) {
          folders.push(entry.path);
        }
      } else {
        files.push(entry.path);
      }
    }
  }
  return { files: files.sort(), complete: true };
}

/** Workspace files whose path under `path` matches a glob pattern. */
export async function globFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
  options: { nativeShell: boolean },
) {
  const requested = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return { error: "pattern is required" };
  const limit = clampedLimit(args.max_results, GLOB_DEFAULT_RESULTS, GLOB_MAX_RESULTS);
  // A pattern without a dot segment never matches inside a hidden folder.
  const hidden = pattern.split("/").some((segment) => segment.startsWith("."));
  let target: string;
  try {
    target = searchTarget(workspace, requested);
  } catch (error) {
    if (error instanceof WorkspacePathError) return { error: error.message, path: requested };
    throw error;
  }
  let listed: string[];
  let complete: boolean;
  if (options.nativeShell) {
    const walked = await walkFiles(sandbox, workspace, target, hidden);
    const base = target === "." ? "" : `${target}/`;
    listed = walked.files.map((file) => (file.startsWith(base) ? file.slice(base.length) : file));
    complete = walked.complete;
  } else {
    const result = await runWorkspaceCommand(
      sandbox,
      await workspace.computer(),
      { argv: globCommandArgv({ target, limit: GLOB_SCAN_MAX_FILES, hidden }), timeoutMs: SEARCH_TIMEOUT_MS },
      workspace.context,
    );
    if (result.timedOut) {
      return {
        error: `listing stopped after ${SEARCH_TIMEOUT_MS / 1000} seconds; narrow path`,
        path: requested,
      };
    }
    const refused = pathError(result.code, requested);
    if (refused) return refused;
    if (result.code !== 0) {
      throw new Error(
        redactSecrets(result.stderr.trim(), workspace.runSecrets) || "could not list files",
      );
    }
    listed = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((file) => file.replace(/^\.\//, ""));
    complete = listed.length <= GLOB_SCAN_MAX_FILES;
    listed = listed.slice(0, GLOB_SCAN_MAX_FILES);
  }
  const matched = listed.filter((file) => path.posix.matchesGlob(file, pattern));
  const prefix = target === "." ? "" : `${target}/`;
  const files = matched
    .slice(0, limit)
    .map((file) => displayPath(workspace, requested, `${prefix}${file}`));
  return fitResult(files, (shown, cut) => ({
    path: requested,
    pattern,
    files: shown,
    truncated: matched.length > limit || cut || !complete,
    ...(complete
      ? {}
      : { note: `only the first ${GLOB_SCAN_MAX_FILES} files were checked; narrow path` }),
  }));
}
