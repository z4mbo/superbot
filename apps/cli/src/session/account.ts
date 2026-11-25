import type { Client } from "@rakazo/cli-client";
import { rememberServer, Client as SuperbotClient, selectedServer } from "@rakazo/cli-client";
import {
  CommandError,
  describeError,
  hinted,
  isUnauthorized,
  withContext,
} from "../output/errors.js";
import { jsonText, terminalText } from "../output/text.js";
import { errorLine, line } from "../terminal/io.js";
import type { CliContext } from "./context.js";

/** The client for this invocation's server: `--server`, then `SUPERBOT_SERVER`, then the saved one. */
export async function selectedClient(context: CliContext, explicit?: string): Promise<Client> {
  return new SuperbotClient(await selectedServer(explicit, context.settings));
}

/** `superbot server [URL]`: saves a default when given one, then prints the effective server. */
export async function serverCommand(
  context: CliContext,
  url: string | undefined,
  explicit: string | undefined,
): Promise<void> {
  const client =
    url === undefined ? await selectedClient(context, explicit) : new SuperbotClient(url.trim());
  if (url !== undefined) {
    try {
      await rememberServer(client, context.settings);
    } catch (error) {
      throw withContext("Could not save the Superbot server address", error);
    }
  }
  line(context.io, terminalText(client.server));
}

/** The saved session for this server, signing in first when a person is at the terminal. */
export async function connect(context: CliContext, client: Client): Promise<Client> {
  const saved = await context.credentials.load(client);
  if (saved) return saved;
  if (!context.io.stdinIsTerminal) {
    throw new CommandError("No saved session for this server. Run superbot login first.");
  }
  await login(context, client, undefined, false);
  const signedIn = await context.credentials.load(client);
  if (!signedIn) throw new CommandError("The saved session disappeared. Run superbot login again.");
  return signedIn;
}

export async function login(
  context: CliContext,
  client: Client,
  email: string | undefined,
  code: boolean,
): Promise<void> {
  const { io } = context;
  if (!io.stdinIsTerminal) throw new CommandError("Sign-in requires an interactive terminal.");
  const account = email ?? (await io.prompt("Email: "));
  if (account === null) throw new CommandError("Sign-in cancelled");
  if (account.trim() === "") throw new CommandError("Enter your email address.");
  let signedIn: Client;
  if (code) {
    await client.requestSignInCode(account.trim());
    const typed = await io.secret("Email code: ");
    signedIn = await client.signInWithCode(account.trim(), typed.trim());
  } else {
    const password = await io.secret("Password: ");
    signedIn = await client.signIn(account.trim(), password);
  }
  await saveSession(context, signedIn);
}

/**
 * Signs in without a terminal, for scripts: the password is the whole of standard input, less one
 * trailing line break.
 */
export async function loginFromStdin(
  context: CliContext,
  client: Client,
  email: string | undefined,
): Promise<void> {
  if (email === undefined) throw new CommandError("Give the account with --email");
  const input = await context.io.readAll();
  const password = input.endsWith("\n") ? input.slice(0, -1).replace(/\r$/, "") : input;
  if (password === "") throw new CommandError("Pipe the password to standard input.");
  const signedIn = await client.signIn(email.trim(), password);
  await saveSession(context, signedIn);
}

export async function signup(context: CliContext, client: Client): Promise<void> {
  const { io } = context;
  if (!io.stdinIsTerminal)
    throw new CommandError("Account creation requires an interactive terminal.");
  line(io, `Create an account at ${client.server}`);
  const name = await io.prompt("Display name: ");
  if (name === null) throw new CommandError("Signup cancelled");
  const email = await io.prompt("Email: ");
  if (email === null) throw new CommandError("Signup cancelled");
  if (name.trim() === "" || email.trim() === "") {
    throw new CommandError("Enter a display name and an email address.");
  }
  const password = await io.secret("New password: ");
  if (password !== (await io.secret("Confirm password: "))) {
    throw new CommandError("Passwords differ.");
  }
  const result = await client.signUp(name.trim(), email.trim(), password);
  if (result.kind === "signedIn") {
    await saveSession(context, result.client);
    return;
  }
  line(io, "Check your email for the verification link, then run superbot login.");
}

/** Saves a new session; one that cannot be saved is revoked so it is not left signed in. */
async function saveSession(context: CliContext, signedIn: Client): Promise<void> {
  try {
    const saved = await context.credentials.save(signedIn);
    if (saved.kind === "file") {
      errorLine(
        context.io,
        `No system credential store is available, so the session is saved in ${saved.path}, readable only by you.`,
      );
    }
  } catch (error) {
    try {
      await signedIn.signOut();
    } catch (revokeError) {
      errorLine(
        context.io,
        `Could not revoke the unsaved session: ${terminalText(describeError(revokeError))}`,
      );
    }
    throw error;
  }
  line(context.io, `Signed in to ${signedIn.server}`);
}

export async function logout(context: CliContext, client: Client): Promise<void> {
  const saved = await context.credentials.load(client);
  if (!saved) {
    line(context.io, "Already signed out.");
    return;
  }
  try {
    await saved.signOut();
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw withContext("Sign-out failed. The saved session can be used to retry", error);
    }
  }
  await context.credentials.delete(client);
  line(context.io, "Signed out.");
}

/** The signed-in account's ID, as the local model settings are keyed by it. */
export async function accountId(client: Client): Promise<string> {
  const me = await hinted(client.rpc("me", null, {}));
  return typeof me.userId === "string" ? me.userId : "";
}

export async function whoami(context: CliContext, client: Client, json: boolean): Promise<void> {
  const me = (await hinted(client.rpc("me", null, {}))) as Record<string, unknown>;
  const text = (key: string) => (typeof me[key] === "string" ? (me[key] as string) : "");
  if (json) {
    line(
      context.io,
      jsonText({
        server: client.server,
        userId: text("userId"),
        email: text("email"),
        name: text("name"),
      }),
    );
    return;
  }
  line(context.io, `${terminalText(text("name"))} <${terminalText(text("email"))}>`);
  line(context.io, terminalText(client.server));
}
