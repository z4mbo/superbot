import { createContext, useContext } from "react";
import type { CloudAccounts } from "./cloud-accounts";

/** Set once by the hosted build's entry, above everything that renders. */
export const CloudAccountsContext = createContext<CloudAccounts | null>(null);

/** The hosted site's account service. Throws outside the hosted build, where there is none. */
export function useCloudAccounts(): CloudAccounts {
  const accounts = useContext(CloudAccountsContext);
  if (!accounts) throw new Error("No cloud account service: not the hosted build");
  return accounts;
}
