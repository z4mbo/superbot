import type { CloudRefusal } from "@rakazo/contracts/cloud-web";

/**
 * What the hosted site can tell about one server from the browser.
 * - `checking`: no answer yet.
 * - `online`: reachable, allows this site, and accepted this account.
 * - `offline`: no answer at all: down, wrong address, or not reachable from this network.
 * - `not-enabled`: something answers at the address, but it does not allow this site. Either it
 *   is not set up for the hosted site or it is not one of our servers.
 * - `unauthorized`: allows this site but turned this account away.
 * - `incompatible`: speaks a different version of the hosted-site protocol.
 */
export type WorkspaceStatus =
  | { state: "checking" }
  | { state: "online"; name: string; version: string }
  | { state: "offline" }
  | { state: "not-enabled" }
  | { state: "unauthorized"; reason: CloudRefusal | "unknown" }
  | { state: "incompatible"; version: string };

export type WorkspaceState = WorkspaceStatus["state"];
