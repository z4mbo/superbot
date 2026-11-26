import type { Client, Space } from "@rakazo/cli-client";
import { SuperbotError } from "@rakazo/cli-client";
import type { RpcInput } from "@rakazo/contracts";
import { MAX_REGISTRY_SEARCH_LENGTH } from "@rakazo/contracts";
import type { Command } from "../cli/commands.js";
import { CommandError } from "../cli/errors.js";
import { quoted } from "../cli/escape.js";
import { checkSlug, readManifestFile, trimText } from "../manifest/manifest-file.js";
import { appSubmission } from "../scaffold/app-scaffold.js";

const SIGN_IN_AGAIN = "Session expired or rejected. Run superbot login for the same server";

/** A command that talks to the registry, ready to run in one Space. */
export type RegistryRequest = (client: Client, spaceId: string) => Promise<unknown>;

type RegistryCommand = Exclude<Command, { kind: "init" | "validate" | "app-init" | "app-check" }>;

/** A rejected session says how to sign in again; every other failure passes through unchanged. */
export function authError(error: unknown): unknown {
  if (error instanceof SuperbotError && error.isUnauthorized()) {
    return new CommandError(`${SIGN_IN_AGAIN}: ${error.message}`, { cause: error });
  }
  return error;
}

async function authorized<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw authError(error);
  }
}

/**
 * Checks the command's arguments and reads its manifest before anything is sent, then returns the
 * call it makes.
 */
export async function registryRequest(
  command: RegistryCommand,
  cwd: string,
): Promise<RegistryRequest> {
  switch (command.kind) {
    case "publish": {
      checkSlug(command.slug);
      const input = {
        slug: command.slug,
        version: command.version,
        manifest: await readManifestFile(command.manifest, cwd),
      };
      return (client, space) => authorized(client.rpc("pluginRegistry/submit", space, input));
    }
    case "app-publish": {
      const input = await appSubmission(command.folder, cwd);
      return (client, space) => authorized(client.rpc("apps/submit", space, input));
    }
    case "list":
      return listRequest(command);
    case "status":
      return (client, space) => submissionStatus(client, space, command.versionId);
    case "agents":
      return async (client, space) => {
        const agents = await authorized(client.listAgents(space));
        return agents.map(({ id, name }) => ({ id, name }));
      };
    case "install": {
      const input = { versionId: command.versionId };
      return (client, space) => authorized(client.rpc("pluginRegistry/install", space, input));
    }
    case "switch-version": {
      const input = {
        installationId: command.installationId,
        expectedVersionId: command.expectedVersionId,
        versionId: command.versionId,
      };
      return (client, space) =>
        authorized(client.rpc("pluginRegistry/switchVersion", space, input));
    }
    case "uninstall": {
      const input = { installationId: command.installationId };
      return (client, space) => authorized(client.rpc("pluginRegistry/uninstall", space, input));
    }
    case "set-grants": {
      if (command.partIds.length > 16) throw new CommandError("Supply at most 16 part IDs");
      for (const id of command.partIds) checkSlug(id);
      const input = {
        installationId: command.installationId,
        botId: command.botId,
        partIds: command.partIds,
      };
      return (client, space) => authorized(client.rpc("pluginRegistry/setGrants", space, input));
    }
    case "review": {
      let input: RpcInput<"pluginRegistry/review">;
      if (command.decision === "approved") {
        if (command.reason !== undefined) {
          throw new CommandError("--reason is only used for rejection");
        }
        input = { versionId: command.versionId, decision: "approved" };
      } else {
        if (command.reason === undefined) throw new CommandError("Rejection requires --reason");
        const reason = trimText(command.reason, "reason", 2000);
        input = { versionId: command.versionId, decision: "rejected", reason };
      }
      return (client, space) => authorized(client.rpc("pluginRegistry/review", space, input));
    }
  }
}

function listRequest(command: Extract<Command, { kind: "list" }>): RegistryRequest {
  const { scope } = command;
  if (command.slug !== undefined && scope !== "discover") {
    throw new CommandError("--slug requires list discover");
  }
  if (command.query !== undefined && scope !== "discover") {
    throw new CommandError("--query requires list discover");
  }
  if (command.status !== undefined && scope !== "submissions") {
    throw new CommandError("--status requires list submissions");
  }
  const page = {
    limit: command.limit,
    ...(command.after === undefined ? {} : { after: command.after }),
  };
  switch (scope) {
    case "discover": {
      if (command.slug !== undefined) checkSlug(command.slug);
      const input = {
        ...page,
        ...(command.slug === undefined ? {} : { slug: command.slug }),
        ...(command.query === undefined
          ? {}
          : { query: trimText(command.query, "query", MAX_REGISTRY_SEARCH_LENGTH) }),
      };
      return (client, space) => authorized(client.rpc("pluginRegistry/discover", space, input));
    }
    case "mine":
      return (client, space) => authorized(client.rpc("pluginRegistry/mine", space, page));
    case "installations":
      return (client, space) => authorized(client.rpc("pluginRegistry/installations", space, page));
    case "submissions": {
      const input = {
        ...page,
        ...(command.status === undefined ? {} : { status: command.status }),
      };
      return (client, space) => authorized(client.rpc("pluginRegistry/submissions", space, input));
    }
  }
}

/** One of the publisher's submitted versions, found by following the registry's page cursors. */
async function submissionStatus(client: Client, space: string, id: string): Promise<unknown> {
  const seen = new Set<string>();
  let after: string | undefined;
  while (true) {
    const page = await authorized(
      client.rpc("pluginRegistry/mine", space, {
        limit: 50,
        ...(after === undefined ? {} : { after }),
      }),
    );
    const version = page.items.find((item) => item.id === id);
    if (version) return version;
    const next = page.nextAfter ?? undefined;
    if (next === undefined) throw new CommandError(`No submitted version with ID ${id}`);
    if (seen.has(next)) throw new CommandError("Registry repeated the pagination cursor");
    seen.add(next);
    after = next;
  }
}

/** The Space named by `--space` (an ID, else an exact unique name), or the member's only one. */
export function selectSpace(spaces: Space[], selection: string | undefined): Space {
  if (selection !== undefined) {
    const byId = spaces.find((space) => space.id === selection);
    if (byId) return byId;
    const matches = spaces.filter((space) => space.name === selection);
    if (matches.length === 0) throw new CommandError(`No Space matches ${quoted(selection)}`);
    if (matches.length > 1) {
      throw new CommandError(`Multiple Spaces match ${quoted(selection)}. Use a Space ID`);
    }
    return matches[0] as Space;
  }
  if (spaces.length === 1) return spaces[0] as Space;
  if (spaces.length === 0) throw new CommandError("Join or create a Space in Superbot first");
  const names = spaces.map((space) => `${quoted(space.name)} (${space.id})`);
  throw new CommandError(`Select a Space with --space. Available Spaces: ${names.join(", ")}`);
}
