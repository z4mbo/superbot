import type { Client, Space } from "@rakazo/cli-client";
import { Client as SuperbotClient } from "@rakazo/cli-client";
import { CommandError, withContext } from "../output/errors.js";
import { terminalText } from "../output/text.js";
import { connect } from "../session/account.js";
import { nameMatches } from "../session/catalog.js";
import type { CliContext } from "../session/context.js";
import { line } from "../terminal/io.js";

export type WorkspaceCommand =
  | { kind: "list" }
  | { kind: "create"; name: string }
  | { kind: "invite" }
  | { kind: "join"; link: string }
  | { kind: "members" }
  | { kind: "leave" };

/** The origin and token of a Superbot workspace invite link. */
export function inviteParts(link: string): { origin: string; token: string } {
  const trimmed = link.trim();
  const at = trimmed.lastIndexOf("/invite/");
  if (at === -1) throw new CommandError("Use the full Superbot workspace invite link");
  const origin = trimmed.slice(0, at);
  const token = trimmed.slice(at + "/invite/".length);
  if (token.length < 1 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new CommandError("The workspace invite link is invalid");
  }
  return { origin, token };
}

/** A Space by ID, else by a name only one Space has. */
export async function resolveSpace(client: Client, name: string): Promise<Space> {
  const spaces = await client.listSpaces();
  const byId = spaces.find((space) => space.id === name);
  if (byId) return byId;
  const matches = spaces.filter((space) => nameMatches(space.name, name));
  const [space] = matches;
  if (!space) throw new CommandError("No matching Space on this server");
  if (matches.length > 1) {
    throw new CommandError("Several Spaces have that name. Use --space with the Space ID.");
  }
  return space;
}

export async function workspacesCommand(
  context: CliContext,
  client: Client,
  overrideServer: boolean,
  spaceName: string | undefined,
  command: WorkspaceCommand,
): Promise<void> {
  const { io } = context;
  if (command.kind === "join") {
    const { origin, token } = inviteParts(command.link);
    let invited: Client;
    try {
      invited = new SuperbotClient(origin);
    } catch (error) {
      throw withContext("The invite must use a Superbot server origin", error);
    }
    if (overrideServer && invited.server !== client.server) {
      throw new CommandError("The invite is for a different Superbot server");
    }
    const signedIn = await context.credentials.load(invited);
    if (!signedIn) {
      throw new CommandError(`Sign in first with superbot --server ${invited.server} login`);
    }
    const preview = await signedIn.rpc("spaces/invites/preview", null, { token });
    const id = preview.alreadyMember
      ? preview.spaceId
      : (await signedIn.rpc("spaces/invites/accept", null, { token })).spaceId;
    line(io, `${terminalText(id)}\t${terminalText(preview.spaceName)}`);
    return;
  }
  const signedIn = await connect(context, client);
  switch (command.kind) {
    case "list":
      for (const space of await signedIn.listSpaces()) {
        line(io, `${terminalText(space.id)}\t${terminalText(space.name)}`);
      }
      return;
    case "create": {
      const scope = spaceName === undefined ? null : (await resolveSpace(signedIn, spaceName)).id;
      const created = await signedIn.rpc("spaces/create", scope, { name: command.name.trim() });
      line(io, `${terminalText(created.id)}\t${terminalText(created.name)}`);
      return;
    }
    default: {
      if (spaceName === undefined) {
        throw new CommandError("Choose the workspace with --space NAME or --space ID");
      }
      const space = await resolveSpace(signedIn, spaceName);
      if (command.kind === "invite") {
        const invite = await signedIn.rpc("spaces/invites/create", space.id, {
          spaceId: space.id,
        });
        line(io, terminalText(invite.url));
      } else if (command.kind === "members") {
        const { members } = await signedIn.rpc("spaces/members/list", space.id, {
          spaceId: space.id,
        });
        for (const member of members) {
          line(io, `${member.role === "owner" ? "owner" : "member"}\t${terminalText(member.name)}`);
        }
      } else {
        await signedIn.rpc("spaces/members/leave", space.id, { spaceId: space.id });
        line(io, `Left ${terminalText(space.name)}`);
      }
    }
  }
}
