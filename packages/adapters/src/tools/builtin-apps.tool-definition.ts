import type { ConnectorTool } from "@rakazo/adapter-kit";

export const READ_APP_STATE = "read_app_state";
export const RUN_APP_ACTION = "run_app_action";

const appRef = {
  pageId: { type: "string", description: "An app page's pageId." },
  app_id: { type: "string", description: "An installed app's app_id, from find_apps." },
} as const;

/** A bot uses an app the same way the person does: it reads its state and runs its actions. */
export const appTools: ConnectorTool[] = [
  {
    name: READ_APP_STATE,
    description:
      "Read an app: its current state, the actions you can run on it (read-only ones marked readOnly) and its cards. An app is a page saved with an app manifest (pass its pageId) or an app the user installed (pass its app_id). Works only when the app lets bots read it.",
    inputSchema: { type: "object", properties: appRef },
    readOnly: true,
  },
  {
    name: RUN_APP_ACTION,
    description:
      "Run one of an app's declared actions, exactly as the person's controls do. An action that changes state returns the new state; an action that runs one of an installed app's functions returns what the function answered. Read the app first for its action names and inputs. Read-only actions need only that the app lets bots read it; others need that it lets bots run its actions.",
    inputSchema: {
      type: "object",
      properties: {
        ...appRef,
        action: { type: "string", description: "A declared action name." },
        input: { type: "object", description: "The action's inputs, as it declares them." },
      },
      required: ["action"],
    },
  },
];
