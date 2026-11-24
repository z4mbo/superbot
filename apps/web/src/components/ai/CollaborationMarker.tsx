import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";

export function CollaborationMarker({
  color,
  avatarSet,
  identity,
  label,
  peerName,
  onClick,
}: {
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  peerName: string;
  onClick: () => void;
}) {
  const parts = splitPeerLabel(label, peerName);
  return (
    <div className="flex min-w-0 max-w-full justify-center">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={label}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-body-sm text-muted-foreground transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          <span dir="auto" className="truncate font-medium">
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </button>
    </div>
  );
}

/**
 * The working bot with what it is doing right now, such as its current tool call. The pointer
 * over the line surprises the bot's face, and a click on a lone bot's mark spins, bounces or nods
 * it.
 */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  const lone = bots.length === 1 ? bots[0] : undefined;
  return (
    <div
      role="status"
      data-bot-mark-emphasis=""
      className="flex min-h-10 min-w-0 items-center gap-2 px-2"
    >
      {lone ? (
        <BotAvatar
          color={lone.color}
          avatarSet={lone.avatarSet}
          identity={lone.botId ?? lone.name}
          size={28}
          status={lone.status}
          pokeable
        />
      ) : (
        <GroupAvatar members={bots} size={28} />
      )}
      <span
        dir="auto"
        className="min-w-0 truncate text-body leading-5.5 text-faint-foreground text-shimmer"
      >
        {label}
      </span>
    </div>
  );
}
