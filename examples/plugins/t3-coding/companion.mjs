import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addRequest, dispatch, installations, saveOnce } from "./inbox.mjs";
import { authorize, endpoint, withT3 } from "./mcp.mjs";
import { superbot } from "./superbot.mjs";

const help = `Superbot T3 Code inbox
  login --t3 URL
  projects
  spaces --server URL --email EMAIL
  installations --server URL --email EMAIL --space ID
  list --server URL --email EMAIL --space ID --installation ID [--after RECORD_ID] [--limit N]
  receipts --server URL --email EMAIL --space ID --installation ID [--after RECORD_ID] [--limit N]
  add --server URL --email EMAIL --space ID --installation ID --title TITLE --brief TEXT
  dispatch --server URL --email EMAIL --space ID --installation ID --record ID --project ID

Use --state-dir DIR to choose the private local state directory. Keep using the same
directory for retries. Sign in with a password, or pass --email-code to use email.
--session-stdin reads an existing signed Superbot session from a pipe.`;

function output(value) {
  console.log(
    JSON.stringify(value, null, 2).replace(
      /\p{Bidi_Control}/gu,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(help);
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      t3: { type: "string" },
      server: { type: "string" },
      email: { type: "string" },
      "email-code": { type: "boolean" },
      space: { type: "string" },
      installation: { type: "string" },
      record: { type: "string" },
      project: { type: "string" },
      title: { type: "string" },
      brief: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      "state-dir": { type: "string" },
      "session-stdin": { type: "boolean" },
    },
  });
  const requireOption = (name) => {
    if (!values[name]?.trim()) throw new Error(`--${name} is required.`);
    return values[name];
  };
  const directory = values["state-dir"] ?? join(homedir(), ".superbot-t3-inbox");
  const authFile = "t3-auth.json";
  const loadAuth = async () => {
    try {
      const auth = JSON.parse(await readFile(join(directory, authFile), "utf8"));
      if (typeof auth.token === "string" && auth.token.length && typeof auth.url === "string") {
        return auth;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    throw new Error("Run login before calling T3 Code.");
  };

  if (command === "login") {
    const url = endpoint(requireOption("t3"), "/mcp");
    try {
      await loadAuth();
      throw new Error("A T3 grant is already saved here. Keep it for pending dispatch retries.");
    } catch (error) {
      if (error.message !== "Run login before calling T3 Code.") throw error;
    }
    const auth = await authorize(url, (link) =>
      console.error(`Open this T3 sign-in URL:\n${link}`),
    );
    const saved = await saveOnce(directory, authFile, auth);
    if (saved.token !== auth.token) throw new Error("Another sign-in already saved a grant.");
    console.log("T3 MCP sign-in saved.");
    return;
  }
  if (command === "projects") {
    await withT3(await loadAuth(), async (call) => {
      let cursor;
      do {
        const page = await call("t3_project_list", { cursor, limit: 50 });
        output(page.projects.map(({ id, title }) => ({ id, title })));
        if (cursor === page.nextCursor) throw new Error("Repeated T3 project cursor.");
        cursor = page.nextCursor;
      } while (cursor !== null);
    });
    return;
  }

  if (!["spaces", "installations", "list", "receipts", "add", "dispatch"].includes(command)) {
    throw new Error("Unknown command. Run with --help.");
  }
  const server = endpoint(requireOption("server"), "/").origin;
  const space = command === "spaces" ? undefined : requireOption("space");
  const installationId = ["spaces", "installations"].includes(command)
    ? undefined
    : requireOption("installation");
  const recordId = command === "dispatch" ? requireOption("record").toLowerCase() : undefined;
  const projectId = command === "dispatch" ? requireOption("project") : undefined;
  if (recordId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(recordId)) {
    throw new Error("--record requires a request record UUID.");
  }
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("--limit must be an integer from 1 to 50.");
  }
  const suppliedSession = values["session-stdin"];
  let token;
  if (suppliedSession) {
    if (process.stdin.isTTY) throw new Error("--session-stdin requires a pipe.");
    token = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      token += chunk;
      if (token.length > 4096) throw new Error("Supply one signed Superbot session.");
    }
    token = token.trim();
    if (!token || /\s/.test(token)) throw new Error("Supply one signed Superbot session.");
  } else {
    token = await superbot(server).signIn(requireOption("email"), values["email-code"]);
  }
  const api = superbot(server, token, space);
  try {
    if (command === "spaces") {
      const { spaces } = await api.rpc("spaces/list", {});
      output(spaces.map(({ id, name }) => ({ id, name })));
      return;
    }
    let installation;
    for await (const candidate of installations(api)) {
      if (command === "installations") {
        output({
          id: candidate.id,
          slug: candidate.plugin.slug,
          version: candidate.plugin.version,
        });
      } else if (candidate.id === installationId) {
        installation = candidate;
        break;
      }
    }
    if (command === "installations") return;
    if (!installation)
      throw new Error("The approved inbox installation is unavailable to this account and Space.");

    if (command === "list" || command === "receipts") {
      const partId = command === "list" ? "requests" : "dispatches";
      output(
        await api.rpc("pluginRegistry/appRecords", {
          installationId,
          partId,
          limit,
          ...(values.after && { after: values.after }),
        }),
      );
    } else if (command === "add") {
      output(
        await addRequest(api, installationId, {
          title: requireOption("title"),
          brief: requireOption("brief"),
        }),
      );
    } else {
      const result = await dispatch({
        api,
        installationId,
        recordId,
        projectId,
        server,
        space,
        directory,
        loadAuth,
      });
      output(result);
      if (!result.savedToInbox) {
        console.error("T3 accepted this request. Retry the same command to save the receipt.");
        process.exitCode = 1;
      }
    }
  } finally {
    if (!suppliedSession) {
      try {
        await api.signOut();
      } catch {
        console.error("The temporary Superbot session could not be signed out.");
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  console.error(
    error instanceof SyntaxError ? "Could not read a response or local state." : error.message,
  );
  process.exitCode = 1;
});
