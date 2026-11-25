import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@rakazo/ui-web";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AccountMenu } from "../../components/account/AccountMenu";
import { SpaceMembersSettings } from "../../components/spaces/SpaceMembersSettings";
import { apiOrigin } from "../../lib/api/api-origin";
import { useSignOut } from "../../lib/auth/sign-out";
import { spaceQueries, useQueryUserId, useSave } from "../../lib/query/query";
import { selectedSpaceId, selectSpace } from "../../lib/query/rpc";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";
import { organizationsQuery } from "../../lib/spaces/organizations";

export function WorkspacesPage() {
  return (
    <SpaceRpcProvider spaceId={null}>
      <WorkspaceSetup />
    </SpaceRpcProvider>
  );
}

function WorkspaceSetup() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = useQueryUserId();
  const spaceList = spaceQueries(userId, null).spaces.list.queryOptions({ input: {} });
  const listing = useQuery(spaceList);
  const organizations = useQuery(organizationsQuery(userId));
  const otherListings = useQueries({
    queries: (organizations.data?.organizations ?? []).flatMap((organization) => {
      if (listing.data && organization.spaceIds.includes(listing.data.current.id)) return [];
      const firstSpace =
        organization.spaceIds.find((id) => id === organization.defaultSpaceId) ??
        organization.spaceIds[0];
      return firstSpace
        ? [spaceQueries(userId, firstSpace).spaces.list.queryOptions({ input: {} })]
        : [];
    }),
  });
  const spaces = new Map(
    [
      ...(listing.data?.spaces ?? []),
      ...otherListings.flatMap(({ data }) => data?.spaces ?? []),
    ].map((space) => [space.id, space]),
  );
  const [mode, setMode] = useState<"create" | "join" | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [membersId, setMembersId] = useState<string | null>(location.state?.joinedSpaceId ?? null);
  const fieldId = useId();
  const { signingOut, logOut } = useSignOut("/sign-in", setError);
  const create = useSave({
    save: (name: string, rpc) => rpc.spaces.create({ name }),
    stale: [spaceList.queryKey, organizationsQuery(userId).queryKey],
    onSaved: (created) => {
      setMembersId(created.id);
      setMode(null);
      setValue("");
    },
  });
  const members = membersId ? spaces.get(membersId) : undefined;

  function openMode(next: typeof mode) {
    setMode(next);
    setValue("");
    setError(null);
    create.reset();
  }

  return (
    <main className="min-h-full bg-background px-6 py-12" data-rakazo-surface="onboarding">
      <AccountMenu signingOut={signingOut} onLogOut={() => void logOut()} />
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <h1 className="text-heading1 font-semibold">
          <Trans>Workspaces</Trans>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => openMode("create")} disabled={create.pending}>
            <Trans>Create workspace</Trans>
          </Button>
          <Button variant="outline" onClick={() => openMode("join")} disabled={create.pending}>
            <Trans>Join with an invite</Trans>
          </Button>
        </div>
        {mode ? (
          <form
            className="flex flex-col items-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const input = value.trim();
              if (!input) return;
              if (mode === "create") {
                create.run(input);
                return;
              }
              // Invite links name the server's own address, which is not this page's on the hosted site.
              const url = URL.parse(input, apiOrigin());
              if (
                !url ||
                url.origin !== apiOrigin() ||
                !/^\/invite\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname)
              ) {
                setError(t`Paste an invite link for this server`);
                return;
              }
              navigate(url.pathname);
            }}
          >
            <Field className="w-full">
              <FieldLabel htmlFor={fieldId}>
                {mode === "create" ? <Trans>Workspace name</Trans> : <Trans>Invite link</Trans>}
              </FieldLabel>
              <Input
                id={fieldId}
                maxLength={mode === "create" ? 60 : undefined}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                  create.reset();
                }}
                disabled={create.pending}
              />
              <FieldError>{create.error ? errorText(create.error) : error}</FieldError>
            </Field>
            <Button type="submit" disabled={!value.trim() || create.pending}>
              {mode === "create" ? <Trans>Create</Trans> : <Trans>Continue</Trans>}
            </Button>
          </form>
        ) : error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {listing.error ? (
          <p role="alert" className="text-destructive">
            {errorText(listing.error)}
          </p>
        ) : null}
        {listing.isPending ? (
          <p role="status" className="text-muted-foreground">
            <Trans>Loading workspaces</Trans>
          </p>
        ) : null}
        <ul className="divide-y divide-border border-y border-border">
          {[...spaces.values()].map((space) => (
            <li key={space.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate">{space.name}</span>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  aria-expanded={membersId === space.id}
                  aria-label={t`People in ${space.name}`}
                  onClick={() => setMembersId(membersId === space.id ? null : space.id)}
                >
                  <Trans>People</Trans>
                </Button>
                <Button
                  variant="outline"
                  aria-label={t`Open ${space.name}`}
                  onClick={() => {
                    if (selectSpace(space.id)) navigate("/app");
                  }}
                >
                  <Trans>Open</Trans>
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {members ? (
          <section className="flex flex-col gap-3" aria-labelledby="workspace-member-heading">
            <h2 id="workspace-member-heading" className="text-heading3 font-semibold">
              {members.name}
            </h2>
            <SpaceRpcProvider spaceId={members.id}>
              <SpaceMembersSettings
                key={members.id}
                space={members}
                onLeft={(activeSpaceId) => {
                  if (selectedSpaceId() === members.id) selectSpace(activeSpaceId);
                  setMembersId(null);
                  void listing.refetch();
                  for (const related of otherListings) void related.refetch();
                }}
              />
            </SpaceRpcProvider>
          </section>
        ) : null}
        <a
          href="/welcome/docs/"
          className="self-start text-body-sm text-muted-foreground underline"
        >
          <Trans>Superbot docs</Trans>
        </a>
      </div>
    </main>
  );
}
