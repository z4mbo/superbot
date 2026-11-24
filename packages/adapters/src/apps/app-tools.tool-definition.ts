import type { ConnectorTool } from "@rakazo/adapter-kit";
import { z } from "zod";

export const FIND_APPS = "find_apps";
export const OPEN_APP = "open_app";

export const findAppsArgs = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Words from the app's name or purpose. Omit to list every installed app."),
});

export const openAppArgs = z.object({
  app_id: z.string().min(1).max(64).describe("The app_id find_apps returned."),
});

export const findAppsTool: ConnectorTool = {
  name: FIND_APPS,
  description:
    "Find apps the user installed in this Space: small interactive tools such as a timer, tracker or calculator that open in a sandboxed view. Use it when the user asks for something an installed app may already do, or asks which apps they have. Results list each app's app_id, purpose and the permissions the user allowed. Pass the app_id to open_app to open it for the user, or to read_app_state and run_app_action to use it.",
  inputSchema: z.toJSONSchema(findAppsArgs, { io: "input" }),
  readOnly: true,
};

/** Opens an installed app in the chat as a page card, with its stored state. */
export const openAppTool: ConnectorTool = {
  name: OPEN_APP,
  description:
    "Open an installed app for the user in the chat, by the app_id find_apps returned. The app runs in a sandbox with only the permissions the user allowed when they installed it.",
  inputSchema: z.toJSONSchema(openAppArgs, { io: "input" }),
  readOnly: true,
};
