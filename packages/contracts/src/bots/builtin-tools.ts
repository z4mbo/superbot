import * as z from "zod";

/** Fleet management tools. Only list_fleet is read-only. */
export const FLEET_TOOL_NAMES = [
  "list_fleet",
  "create_group",
  "update_group",
  "organize_bot",
  "set_child_instructions",
  "set_child_bot_model",
  "create_child_routine",
] as const;

export const FLEET_WRITE_TOOL_NAMES = FLEET_TOOL_NAMES.filter(
  (name): name is Exclude<(typeof FLEET_TOOL_NAMES)[number], "list_fleet"> => name !== "list_fleet",
);

/** What a feedback report is about, and how long its description may be. */
export const FEEDBACK_KINDS = ["bug", "feedback"] as const;
export const FEEDBACK_DESCRIPTION_MAX_LENGTH = 2_000;

/** Web search offered only to a person who saved a key for its provider in Settings. */
export const KEYED_SEARCH_TOOL_NAMES = ["exa_search"] as const;
/** Page reading offered only to a person who saved a key for its provider in Settings. */
export const KEYED_PAGE_READ_TOOL_NAMES = ["firecrawl_scrape"] as const;
export const KEYED_RESEARCH_TOOL_NAMES = [
  ...KEYED_SEARCH_TOOL_NAMES,
  ...KEYED_PAGE_READ_TOOL_NAMES,
] as const;

/** Built-in tool names a bot may disable. Kept aligned with the adapter tool list. */
export const BUILTIN_TOOL_NAMES = [
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "glob",
  "attach_file",
  "shell",
  "process_manage",
  "user_computer_list",
  "user_computer_shell",
  "user_computer_observe",
  "user_computer_act",
  "open_path",
  "launch_app",
  "request_takeover",
  "ask_user",
  "connect_app",
  "message_user",
  "request_secret",
  "generate_secret",
  "list_secrets",
  "secret_request",
  "forget_secret",
  "render_plot",
  "save_page",
  "read_app_state",
  "run_app_action",
  "find_apps",
  "open_app",
  "generate_image",
  "edit_image",
  "generate_video",
  "vision_analyze",
  "video_analyze",
  "add_mcp_server",
  "remove_mcp_server",
  "remember",
  "save_shared_memory",
  "delete_shared_memory",
  "web_search",
  "web_fetch",
  ...KEYED_RESEARCH_TOOL_NAMES,
  "service_search",
  "service_call",
  "cloud_agent_launch",
  "cloud_agent_status",
  "cloud_agent_reply",
  "cloud_agent_cancel",
  "request_purchase",
  "purchase_status",
  "paid_request",
  "sign_in",
  "search_history",
  "read_history",
  "read_meeting_transcript",
  "list_calendars",
  "list_calendar_events",
  "create_calendar_event",
  "list_reminders",
  "create_reminder",
  "complete_reminder",
  "read_email",
  "delete_email",
  "claim_email_address",
  "send_email",
  "save_memory",
  "recall_memory",
  "forget_memory",
  "reflect_memory",
  "task_catalog",
  "scratchpad_list",
  "scratchpad_add",
  "scratchpad_update",
  "scratchpad_complete",
  "scratchpad_remove",
  "board_tickets",
  "ticket_get",
  "ticket_create",
  "ticket_update",
  "ticket_comment",
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_cancel",
  "end_call",
  "call_user",
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
  "run_subagent",
  "delegate",
  "follow_up",
  "stop_task",
  "link_to_thread",
  "offer_check_in",
  "create_space",
  "spawn_bot",
  "update_bot",
  ...FLEET_TOOL_NAMES,
  "archive_bot",
  "message_bot",
  "handoff_to_bot",
  "post_to_group",
  "update_preferences",
  "feedback",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
] as const;

export const BuiltinToolNameSchema = z.enum(BUILTIN_TOOL_NAMES);
export type BuiltinToolName = z.infer<typeof BuiltinToolNameSchema>;

const builtinToolNameSet: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return builtinToolNameSet.has(name);
}

/**
 * Built-ins that do part of another's job, so turning that one off turns them off too: a bot
 * without shell starts no background command, one without write_file edits no file, and one
 * without delegate has no task threads to follow up, stop or link to.
 */
const BUILTIN_TOOL_FOLLOWS: Readonly<Partial<Record<BuiltinToolName, BuiltinToolName>>> = {
  edit_file: "write_file",
  search_files: "read_file",
  glob: "list_files",
  process_manage: "shell",
  follow_up: "delegate",
  stop_task: "delegate",
  link_to_thread: "delegate",
  offer_check_in: "schedule_create",
};

/** Whether a built-in is off, by its own name or the tool it follows. */
export function builtinToolDisabled(disabled: ReadonlySet<string>, name: string): boolean {
  if (disabled.has(name)) return true;
  const follows = isBuiltinToolName(name) ? BUILTIN_TOOL_FOLLOWS[name] : undefined;
  return follows !== undefined && disabled.has(follows);
}

export function disabledBuiltinToolSet(names: readonly string[] | undefined): Set<string> {
  const disabled = new Set<string>();
  if (!names) return disabled;
  for (const raw of names) {
    const name = raw.trim();
    if (isBuiltinToolName(name)) disabled.add(name);
  }
  return disabled;
}

export const DisabledBuiltinToolsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(BUILTIN_TOOL_NAMES.length)
  .superRefine((names, ctx) => {
    names.forEach((name, index) => {
      if (!isBuiltinToolName(name)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown built-in tool: ${name}`,
          path: [index],
        });
      }
    });
  })
  .transform((names) => [...new Set(names)]);
