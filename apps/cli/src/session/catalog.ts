import type { Agent, Client, Space } from "@rakazo/cli-client";
import { CommandError, hinted } from "../output/errors.js";
import { jsonText, quoted, terminalText } from "../output/text.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";

/** An agent as the command names it: its ID and name. */
export type AgentRef = Pick<Agent, "id" | "name">;
export type SpaceRef = Pick<Space, "id" | "name">;

/** Each Space with its agents. */
export type Catalog = Array<{ space: SpaceRef; agents: AgentRef[] }>;

/** A name matches exactly, or ignoring case. */
export function nameMatches(candidate: string, query: string): boolean {
  return candidate === query || candidate.toLowerCase() === query.toLowerCase();
}

/** The member's Spaces and their agents; only the Space named `spaceName` when one is given. */
export async function discover(client: Client, spaceName: string | undefined): Promise<Catalog> {
  let spaces = await hinted(client.listSpaces());
  if (spaceName !== undefined) {
    spaces = spaces.filter((space) => nameMatches(space.name, spaceName));
    if (spaces.length === 0) {
      throw new CommandError(
        `No space named ${quoted(spaceName)}. Run superbot list to see available spaces.`,
      );
    }
    if (spaces.length > 1) {
      throw new CommandError(
        `More than one space is named ${quoted(spaceName)}. Use the picker to choose one.`,
      );
    }
  }
  const catalog: Catalog = [];
  for (const space of spaces) {
    const agents = await hinted(client.listAgents(space.id));
    catalog.push({ space, agents });
  }
  return catalog;
}

/** Every agent with its Space, in catalog order. */
export function agentsIn(catalog: Catalog): Array<{ space: SpaceRef; agent: AgentRef }> {
  return catalog.flatMap(({ space, agents }) => agents.map((agent) => ({ space, agent })));
}

/** The agent with this exact name, else the one whose name matches ignoring case. */
export function findAgent(catalog: Catalog, name: string): { space: SpaceRef; agent: AgentRef } {
  const choose = (exact: boolean) => {
    const matches = agentsIn(catalog).filter(({ agent }) =>
      exact ? agent.name === name : nameMatches(agent.name, name),
    );
    if (matches.length > 1) {
      throw new CommandError(
        `More than one agent matches ${quoted(name)}. Select its space with --space or use the picker.`,
      );
    }
    return matches[0];
  };
  const found = choose(true) ?? choose(false);
  if (!found) {
    throw new CommandError(
      `No agent named ${quoted(name)}. Run superbot list to see available agents.`,
    );
  }
  return found;
}

/** `superbot list`: each Space and its agents. */
export function printCatalog(io: Io, catalog: Catalog, json: boolean): void {
  if (json) {
    line(
      io,
      jsonText(
        catalog.map(({ space, agents }) => ({
          id: space.id,
          name: space.name,
          agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
        })),
      ),
    );
    return;
  }
  for (const { space, agents } of catalog) {
    line(io, terminalText(space.name));
    for (const agent of agents) line(io, `  ${terminalText(agent.name)}`);
  }
}
