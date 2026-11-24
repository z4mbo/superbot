import type { LabFeature } from "@rakazo/contracts";

/**
 * The Labs this app has a row for. The server can offer a feature this app no longer shows, so
 * the Labs section and its entry point list only these.
 */
const SHOWN_LABS: readonly LabFeature[] = [];

export function shownLabs(available: readonly LabFeature[] | null | undefined): LabFeature[] {
  return (available ?? []).filter((feature) => SHOWN_LABS.includes(feature));
}
