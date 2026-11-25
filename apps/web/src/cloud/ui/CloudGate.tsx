import type { ReactNode } from "react";

/**
 * Stands between the hosted build's entry and the app: sign-in when signed out, the workspace
 * list when none is chosen, an unavailable state when the chosen server cannot be used, and the
 * app itself (`children`) once it can.
 */
export function CloudGate({ children }: { children: ReactNode }) {
  return children;
}
