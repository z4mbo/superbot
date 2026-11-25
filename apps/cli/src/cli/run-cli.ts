import { chatCommand } from "../chat/chat.js";
import { approvalsCommand } from "../commands/approvals-command.js";
import { importBots, readRoster } from "../commands/import-bots.js";
import { sendCommand } from "../commands/send.js";
import { conversations, printConversations, showConversation } from "../commands/threads.js";
import { workspacesCommand } from "../commands/workspaces.js";
import { CommandError, describeError, Exit } from "../output/errors.js";
import { terminalText } from "../output/text.js";
import {
  connect,
  login,
  loginFromStdin,
  logout,
  selectedClient,
  serverCommand,
  signup,
  whoami,
} from "../session/account.js";
import { discover, findAgent, printCatalog } from "../session/catalog.js";
import type { CliContext } from "../session/context.js";
import { errorLine } from "../terminal/io.js";
import type { Command, GlobalOptions } from "./args.js";
import { parseArgs } from "./args.js";

/** Runs one command line and returns its exit status; output goes to the context's terminal. */
export async function runCli(argv: string[], context: CliContext): Promise<number> {
  const parsed = parseArgs(argv, context.settings.env ?? process.env);
  if (parsed.kind === "print") {
    context.io.out(parsed.text);
    return 0;
  }
  if (parsed.kind === "usage") {
    context.io.err(parsed.text);
    return 2;
  }
  try {
    await run(context, parsed.global, parsed.command);
    return 0;
  } catch (error) {
    // The command already printed what happened.
    if (error instanceof Exit) return error.code;
    errorLine(context.io, `superbot: ${terminalText(describeError(error))}`);
    return 1;
  }
}

async function run(context: CliContext, global: GlobalOptions, command: Command): Promise<void> {
  if (command.kind === "server") {
    await serverCommand(context, command.url, global.server);
    return;
  }
  const client = await selectedClient(context, global.server);
  switch (command.kind) {
    case "signup":
      return signup(context, client);
    case "login":
      return command.passwordStdin
        ? loginFromStdin(context, client, command.email)
        : login(context, client, command.email, command.code);
    case "logout":
      return logout(context, client);
    case "whoami":
      return whoami(context, await connect(context, client), global.json);
    case "list": {
      const signedIn = await connect(context, client);
      printCatalog(context.io, await discover(signedIn, global.space), global.json);
      return;
    }
    case "send":
      return sendCommand(
        context,
        await connect(context, client),
        global.space,
        command,
        global.json,
      );
    case "threadsList":
    case "threadsShow": {
      const signedIn = await connect(context, client);
      const catalog = await discover(signedIn, global.space);
      const { space, agent } = findAgent(catalog, command.agent);
      if (command.kind === "threadsList") {
        printConversations(
          context.io,
          await conversations(signedIn, space.id, agent.id),
          global.json,
        );
        return;
      }
      return showConversation(context.io, signedIn, space.id, agent, command.threadId, global.json);
    }
    case "tui": {
      const signedIn = await connect(context, client);
      const { runTui } = await import("../tui/run.js");
      return runTui(signedIn, global.space);
    }
    case "approvals": {
      const signedIn = await connect(context, client);
      const catalog = await discover(signedIn, global.space);
      return approvalsCommand(context.io, signedIn, catalog, command.answer, global.json);
    }
    case "workspaces":
      return workspacesCommand(
        context,
        client,
        global.serverOverridden,
        global.space,
        command.command,
      );
    case "importBots": {
      if (global.space === undefined) {
        throw new CommandError("Choose the destination with --space NAME or --space ID");
      }
      const names = await readRoster(command.file);
      const signedIn = await connect(context, client);
      return importBots(context.io, signedIn, global.space, names, command.dryRun);
    }
    case "chat": {
      const signedIn = await connect(context, client);
      const catalog = await discover(signedIn, global.space);
      return chatCommand(context, signedIn, catalog, command);
    }
  }
}
