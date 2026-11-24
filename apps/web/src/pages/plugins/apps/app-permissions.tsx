import { Trans } from "@lingui/react/macro";
import type { AppPermission } from "@rakazo/contracts";
import type { ReactElement } from "react";

function permissionLabel(permission: AppPermission): ReactElement {
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
  }
}

/** What an app may do, one line each, as the install asks for or granted it. */
export function AppPermissionList({ permissions }: { permissions: readonly AppPermission[] }) {
  if (!permissions.length)
    return (
      <p className="text-body text-muted-foreground">
        <Trans>Needs no permissions</Trans>
      </p>
    );
  return (
    <ul className="list-disc space-y-1 ps-5 text-body text-foreground">
      {permissions.map((permission) => (
        <li key={permission}>{permissionLabel(permission)}</li>
      ))}
    </ul>
  );
}
