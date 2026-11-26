import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { spaceInvitee } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Lock, Users, X } from "lucide-react";
import { useState } from "react";
import type { InvitationEmailResult } from "../../../components/spaces/InvitationEmailNotice";
import { InvitationEmailNotice } from "../../../components/spaces/InvitationEmailNotice";
import { PersonRow } from "../../../components/spaces/PersonRow";
import { useQueryUserId, useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

/** The Space a bot belongs to: everyone in it can use the bot. */
export type BotSpace = { id: string; name: string; shared?: boolean };

const INTRO_DISMISSED_KEY = "rakazo:bot-share-intro-dismissed";

function readDismissed() {
  try {
    return localStorage.getItem(INTRO_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Who can use a bot. A bot belongs to its Space, so its people are the Space's members; the pill
 * says whether that is only you, and its popover adds people to the Space.
 */
export function BotAccessButton({
  bot,
  space,
}: {
  bot: Pick<Bot, "id" | "name" | "color" | "avatarSet" | "status">;
  space: BotSpace;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const shared = space.shared === true;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="floating"
            size="lg"
            data-testid="bot-access-trigger"
            className="app-no-drag px-4 font-normal"
          />
        }
      >
        {shared ? (
          <Users strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Lock strokeWidth={1.75} aria-hidden="true" />
        )}
        {shared ? t`Shared` : t`Private`}
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="end"
          sideOffset={6}
          className="app-no-drag w-[360px] max-w-[calc(100vw-32px)] gap-0 p-0"
          data-testid="bot-share-popover"
        >
          <BotSharePanel bot={bot} space={space} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function BotSharePanel({
  bot,
  space,
}: {
  bot: Pick<Bot, "id" | "name" | "color" | "avatarSet" | "status">;
  space: BotSpace;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const queries = useSpaceQueries();
  const membersOptions = queries.spaces.members.list.queryOptions({
    input: { spaceId: space.id },
  });
  const members = useQuery({ ...membersOptions, refetchOnMount: "always" });
  const list = members.data;
  const shared = list ? list.members.length > 1 : space.shared === true;
  const canManage = list?.canManage === true;
  const me = list?.members.find((member) => member.userId === userId);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ email: string; result: InvitationEmailResult } | null>(null);
  const adding = useSave({
    save: (ask: { spaceId: string; userId: string }, client) => client.spaces.members.add(ask),
    stale: [membersOptions.queryKey],
    onSaved: () => setEmail(""),
  });
  const emailing = useSave({
    save: (ask: { spaceId: string; email: string }, client) => client.spaces.invites.create(ask),
    stale: [membersOptions.queryKey],
    onSaved: (result, ask) => {
      setEmail("");
      setSent({ email: ask.email, result });
    },
  });
  const invitee = list && email.trim() ? spaceInvitee(list, email) : null;
  const failure = adding.error
    ? errorText(adding.error, t`Could not add member`)
    : emailing.error
      ? errorText(emailing.error, t`Could not invite`)
      : members.error
        ? errorText(members.error, t`Could not load members`)
        : null;

  function invite() {
    if (!invitee) return;
    setSent(null);
    if (invitee.kind === "outside") emailing.run({ spaceId: space.id, email: email.trim() });
    else if (invitee.kind === "addable") adding.run({ spaceId: space.id, userId: invitee.userId });
    else setEmail("");
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="px-1 pt-1 text-body text-foreground">
        <Trans>Share this Bot</Trans>
      </div>
      {canManage && !shared && !dismissed ? (
        <div
          data-testid="bot-share-intro"
          className="relative flex flex-col items-center gap-1 rounded-xl bg-muted px-6 pt-5 pb-4 text-center"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            className="absolute end-2 top-2 text-muted-foreground"
            onClick={() => {
              setDismissed(true);
              try {
                localStorage.setItem(INTRO_DISMISSED_KEY, "1");
              } catch {
                // Without storage it only stays dismissed until the page reloads.
              }
            }}
          >
            <X />
          </Button>
          <div className="mb-2 flex items-center -space-x-1.5" aria-hidden="true">
            {me ? <PersonAvatar person={me} /> : null}
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={32}
              status={bot.status}
            />
          </div>
          <div className="text-body-lg font-medium text-foreground">
            <Trans>Bring your team in</Trans>
          </div>
          <p className="text-body-sm text-muted-foreground">
            <Trans>People you add join {space.name} and can use its bots.</Trans>
          </p>
        </div>
      ) : null}
      {canManage ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            invite();
          }}
        >
          <div className="flex gap-2">
            <Input
              type="email"
              aria-label={t`Add people by email`}
              placeholder={t`Add people by email`}
              autoComplete="off"
              value={email}
              disabled={emailing.pending || adding.pending}
              onChange={(event) => {
                setEmail(event.target.value);
                adding.reset();
                emailing.reset();
              }}
            />
            {email.trim() ? (
              <Button type="submit" disabled={!invitee || emailing.pending || adding.pending}>
                <Trans>Invite</Trans>
              </Button>
            ) : null}
          </div>
          {invitee?.kind === "outside" && list?.organizationName ? (
            <p className="px-1 text-body-sm text-muted-foreground">
              <Trans>Not in {list.organizationName}. They'll only see this Space.</Trans>
            </p>
          ) : null}
        </form>
      ) : null}
      {sent ? <InvitationEmailNotice email={sent.email} sent={sent.result} /> : null}
      {failure ? <p className="px-1 text-body-sm text-destructive">{failure}</p> : null}
      <section className="flex flex-col gap-1">
        <SectionHeading variant="label" className="px-1">
          <Trans>Who has access</Trans>
        </SectionHeading>
        <div className="flex items-center gap-2.5 px-1 py-1.5" data-testid="bot-access-summary">
          <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
            {shared ? (
              <Users className="size-4" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Lock className="size-4" strokeWidth={1.75} aria-hidden="true" />
            )}
          </span>
          <span className="text-body text-foreground">
            {shared ? <Trans>Everyone in {space.name}</Trans> : <Trans>Only you</Trans>}
          </span>
        </div>
        {list ? (
          <ul className="-mx-3 border-t border-hairline" aria-label={t`Who has access`}>
            {list.members.map((member) => (
              <PersonRow
                key={member.userId}
                person={member}
                badge={
                  member.userId === userId ? (
                    <span className="text-body text-muted-foreground">
                      <Trans>(You)</Trans>
                    </span>
                  ) : null
                }
                trailing={
                  member.role === "owner" ? (
                    <span className="text-body-sm text-muted-foreground">
                      <Trans>Owner</Trans>
                    </span>
                  ) : null
                }
              />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function PersonAvatar({
  person,
}: {
  person: { name: string; email: string; image: string | null };
}) {
  const initial = (person.name || person.email).trim().charAt(0).toUpperCase();
  return (
    <span className="grid size-8 place-items-center overflow-hidden rounded-full border-2 border-muted bg-background text-body-sm font-medium text-foreground">
      {person.image ? (
        <img src={person.image} alt="" className="size-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}
