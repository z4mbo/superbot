import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import type { ComputerLocation } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import { computerProviders, isKnownSandboxKind, knownSandboxKinds } from "../computer-providers.js";

export type { KnownSandboxKind } from "../computer-providers.js";
export { isKnownSandboxKind, knownSandboxKinds };

/** A stored kind no provider declares anymore reads as a plain remote Linux computer. */
const UNDECLARED_KIND_CAPABILITIES: SandboxKindCapabilities = {
  terminal: false,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: false,
  storedHomeIsBackup: false,
};

/**
 * Read by the computer's own kind, never from the deployment's provider: one deployment can
 * run computers of several kinds.
 */
export function sandboxKindCapabilities(kind: string | null | undefined): SandboxKindCapabilities {
  return isKnownSandboxKind(kind)
    ? computerProviders[kind].capabilities
    : UNDECLARED_KIND_CAPABILITIES;
}

/** Which machine a kind's computers run on, when it is the server's own or the user's. */
export function computerLocation(kind: string | null | undefined): ComputerLocation | undefined {
  const capabilities = sandboxKindCapabilities(kind);
  if (capabilities.runsOnUserMachine) return "device";
  if (capabilities.runsOnServer) return "server";
  return undefined;
}

export function sandboxKindsWhere(
  matches: (capabilities: SandboxKindCapabilities) => boolean,
): string[] {
  return knownSandboxKinds.filter((kind) => matches(computerProviders[kind].capabilities));
}
