import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import {
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
  WorkspacePathError,
} from "../../computers/screens/computer-support.js";
import { EDIT_FILE_MAX_BYTES, EDIT_FILE_MAX_KB } from "../builtin-computer.tool-definition.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import { applyUnifiedPatch, replaceInText } from "./text-edit.js";

export type EditFileResult =
  | { ok: true; path: string; replacements?: number; hunks?: number; bytes: number }
  | { error: string; path: string };

function given(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Which edit the arguments ask for: exactly one of old_string/new_string or patch. */
function editMode(
  args: Record<string, unknown>,
):
  | { mode: "replace"; oldString: string; newString: string }
  | { mode: "patch"; patch: string }
  | { error: string } {
  const replace = given(args.old_string);
  const patch = given(args.patch);
  if (replace && patch) return { error: "send old_string and new_string, or patch, not both" };
  if (patch) return { mode: "patch", patch: args.patch as string };
  if (!replace) return { error: "send old_string and new_string, or patch" };
  if (typeof args.new_string !== "string")
    return { error: "new_string is required with old_string" };
  return { mode: "replace", oldString: args.old_string as string, newString: args.new_string };
}

/**
 * Edit part of a text file in the bot's workspace and write it back whole. The file is read and
 * written through the computer's own file API, so paths resolve and stay contained exactly as for
 * read_file and write_file. The result never carries file text.
 */
export async function editFileFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
): Promise<EditFileResult> {
  const { botId, computerMode, computer, context } = workspace;
  const filePath = typeof args.path === "string" ? args.path : "";
  if (!filePath.trim()) return { error: "path is required", path: filePath };
  const edit = editMode(args);
  if ("error" in edit) return { error: edit.error, path: filePath };
  let storedPath: string;
  try {
    storedPath = resolveBotWorkspacePath(computerMode, botId, filePath);
    normalizeWorkspacePath(storedPath);
  } catch (error) {
    if (error instanceof WorkspacePathError) return { error: error.message, path: filePath };
    throw error;
  }
  const ref = await computer();
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(ref, storedPath, context, { maxBytes: EDIT_FILE_MAX_BYTES });
  } catch (error) {
    if (error instanceof SandboxFileTooLargeError) {
      return { error: `file is over ${EDIT_FILE_MAX_KB} KB; change it with shell`, path: filePath };
    }
    // A link that leads out of the workspace is refused by the computer's file API.
    if (error instanceof WorkspacePathError) return { error: error.message, path: filePath };
    throw error;
  }
  if (bytes.byteLength > EDIT_FILE_MAX_BYTES) {
    return { error: `file is over ${EDIT_FILE_MAX_KB} KB; change it with shell`, path: filePath };
  }
  let text: string;
  try {
    if (bytes.includes(0)) throw new TypeError("binary");
    // A byte order mark stays where it is.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: "file is not UTF-8 text; edit_file only changes text files", path: filePath };
  }
  const edited =
    edit.mode === "replace"
      ? replaceInText(text, edit.oldString, edit.newString, args.replace_all === true)
      : applyUnifiedPatch(text, edit.patch);
  if ("error" in edited) return { error: edited.error, path: filePath };
  // Writing replaces the file, so carry its executable bit over.
  const stored = normalizeWorkspacePath(storedPath);
  const entries = await sandbox.listFiles(ref, path.posix.dirname(storedPath), context);
  const executable = entries.some((entry) => entry.path === stored && entry.executable === true);
  const content = new TextEncoder().encode(edited.text);
  workspace.markDirty();
  await sandbox.writeFile(ref, { path: storedPath, content, executable }, context);
  return {
    ok: true,
    path: filePath,
    ...(edit.mode === "replace" ? { replacements: edited.count } : { hunks: edited.count }),
    bytes: content.byteLength,
  };
}
