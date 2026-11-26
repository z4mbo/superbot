import { Trans } from "@lingui/react/macro";
import type { AppPermission } from "@rakazo/contracts";
import type { ReactElement } from "react";

function permissionLabel(permission: AppPermission, hosts: readonly string[]): ReactElement {
  switch (permission) {
    case "state":
      return <Trans>Save its own data</Trans>;
    case "agent:read":
      return <Trans>Let bots read its data</Trans>;
    case "agent:actions":
      return <Trans>Let bots use its actions</Trans>;
    case "reply":
      return <Trans>Suggest replies in chat</Trans>;
    case "links":
      return <Trans>Open links you confirm</Trans>;
    case "clipboard":
      return <Trans>Copy text when you click</Trans>;
    case "data":
      return <Trans>Keep its own records</Trans>;
    case "network": {
      const list = hosts.join(", ");
      return <Trans>Connect to {list}</Trans>;
    }
  }
}

/**
 * What an app may do, one line each, as the install asks for or granted it. The hosts its
 * functions may call are named, so the person sees where its data can go.
 */
export function AppPermissionList({
  permissions,
  hosts = [],
}: {
  permissions: readonly AppPermission[];
  hosts?: readonly string[];
}) {
  if (!permissions.length)
    return (
      <p className="text-body text-muted-foreground">
        <Trans>Needs no permissions</Trans>
      </p>
    );
  return (
    <ul className="list-disc space-y-1 ps-5 text-body text-foreground">
      {permissions.map((permission) => (
        <li key={permission}>{permissionLabel(permission, hosts)}</li>
      ))}
    </ul>
  );
}
