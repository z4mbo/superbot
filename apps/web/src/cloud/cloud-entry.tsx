import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { CloudAccounts } from "./accounts/cloud-accounts";
import { loadCloudAccounts } from "./accounts/cloud-accounts";
import { CloudAccountsContext } from "./accounts/cloud-accounts-context";
import { CloudGate } from "./ui/CloudGate";

/**
 * The hosted site: its account service, then the gate that mounts the app only once a workspace
 * can be used. A build without the service's key stops here with the reason instead of a blank
 * page. Loaded by the entry with a dynamic import, so the self-hosted build never fetches it.
 */
export async function renderCloud(
  root: Root,
  frame: (children: ReactNode) => ReactNode,
  app: ReactNode,
): Promise<void> {
  let accounts: CloudAccounts;
  try {
    accounts = await loadCloudAccounts();
  } catch (error) {
    console.error(error);
    root.render(
      <p style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        {error instanceof Error ? error.message : String(error)}
      </p>,
    );
    return;
  }
  root.render(
    frame(
      <accounts.Provider>
        <CloudAccountsContext.Provider value={accounts}>
          <CloudGate>{app}</CloudGate>
        </CloudAccountsContext.Provider>
      </accounts.Provider>,
    ),
  );
}
