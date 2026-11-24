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
      "Read an app's current state and the actions you can run on it. An app is a page saved with an app manifest (pass its pageId) or an app the user installed (pass its app_id). Works only when the app lets bots read it.",
    inputSchema: { type: "object", properties: appRef },
    readOnly: true,
  },
  {
    name: RUN_APP_ACTION,
    description:
      "Run one of an app's declared actions, exactly as the person's controls do, and get the new state back. Read the app first for its action names and inputs. Works only when the app lets bots run its actions.",
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
