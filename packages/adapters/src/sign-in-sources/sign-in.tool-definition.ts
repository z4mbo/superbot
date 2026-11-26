import type { ConnectorTool } from "@rakazo/adapter-kit";
import * as z from "zod";

export const SIGN_IN_TOOL = "sign_in";

/** Only the site: nothing the bot sends can approve a login or name one. */
export const SignInInput = z
  .object({
    site: z
      .string()
      .max(2048)
      .describe("The HTTPS address of the sign-in page open in the browser."),
  })
  .strict();

export const signInTool: ConnectorTool = {
  name: SIGN_IN_TOOL,
  description:
    "Sign in to a website with a login from the user's password manager. Open the site's sign-in form with browser_navigate first. The user approves the login in their password manager's app from a card in the chat; their browser extension then fills and submits it. You never see the username, password or code: the result only says whether the login was filled. Never ask the user to type a password, code or username into the chat.",
  inputSchema: z.toJSONSchema(SignInInput, { io: "input" }),
  readOnly: false,
};
