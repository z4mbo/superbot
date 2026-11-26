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
  card: z
    .string()
    .max(40)
    .optional()
    .describe("One of the app's cards, by name, to show instead of the whole app."),
  input: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("The card's input, as the card declares it."),
});

export const findAppsTool: ConnectorTool = {
  name: FIND_APPS,
  description:
    "Find apps the user installed in this Space: interactive tools such as a tracker, diary or calculator that open in a sandboxed view and may keep their own records. Use it when the user asks for something an installed app may already do, or asks which apps they have. Results list each app's app_id, purpose, the permissions the user allowed, the actions you may run (read-only ones marked) and its cards. Pass the app_id to open_app to show it or one of its cards, and to read_app_state and run_app_action to use it.",
  inputSchema: z.toJSONSchema(findAppsArgs, { io: "input" }),
  readOnly: true,
};

/** Opens an installed app in the chat as a page card, with its stored state, or one of its cards. */
export const openAppTool: ConnectorTool = {
  name: OPEN_APP,
  description:
    "Show an installed app to the user in the chat, by the app_id find_apps returned. Pass card (and its input) to show one of the app's cards, such as a summary or a form, instead of the whole app. To update what a card shows, open it again with another input, or run an action that changes the app's data; open cards follow. The app runs in a sandbox with only the permissions the user allowed when they installed it.",
  inputSchema: z.toJSONSchema(openAppArgs, { io: "input" }),
  readOnly: true,
};
