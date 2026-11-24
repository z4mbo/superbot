import type { BotAvatarSet } from "@rakazo/contracts";
import type { BotMarkShape } from "@rakazo/core";
import { botMarkShapeFor } from "@rakazo/core";
import { memo } from "react";
import type { AvatarCutoutHole } from "./avatar-cutout.js";
import { avatarCutoutStyle } from "./avatar-cutout.js";
import { BotAvatar, parseBotAvatar, usePickedBotLooks } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  avatarSet?: BotAvatarSet;
  status?: string;
}

export interface GroupAvatarProps {
  members: GroupAvatarMember[];
  size?: number;
  className?: string;
}

/** A group shows its first four members, as the reference does. */
const MAX_MEMBERS = 4;

type Place = { x: number; y: number; size: number };

function groupPlaces(count: number, frame: number): Place[] {
  if (count <= 1) return [{ x: 0, y: 0, size: frame }];
  if (count === 2) {
    const size = (frame * 2) / 3;
    return [
      { x: 0, y: 0, size },
      { x: frame - size, y: frame - size, size },
    ];
  }
  const size = (frame * 5) / 9;
  const far = frame - size;
  return count === 3
    ? [
        { x: far / 2, y: 0, size },
        { x: 0, y: far, size },
        { x: far, y: far, size },
      ]
    : [
        { x: 0, y: 0, size },
        { x: far, y: 0, size },
        { x: 0, y: far, size },
        { x: far, y: far, size },
      ];
}

/** The body a member's mark draws, so the gap around it follows its outline; none for a photo. */
function memberShape(
  member: GroupAvatarMember,
  looks: ReturnType<typeof usePickedBotLooks>,
): BotMarkShape | null {
  const parsed = parseBotAvatar(member.color);
  if (parsed.isImage) return null;
  const identity = member.botId ?? member.name ?? "";
  return botMarkShapeFor(
    identity || parsed.color || "agent",
    looks.get(identity)?.lookShape,
    parsed.shapeIndex,
  );
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 38,
  className,
}: GroupAvatarProps) {
  const looks = usePickedBotLooks();
  const firstMember = members[0];
  if (!firstMember) {
    return (
      <div
        className={cn(
          "rakazo-group-avatar relative flex items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size, flex: "none" }}
      >
        <svg
          aria-hidden="true"
          style={{ width: Math.round(size * 0.48), height: Math.round(size * 0.48) }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={firstMember.color}
        avatarSet={firstMember.avatarSet}
        identity={firstMember.botId ?? firstMember.name}
        size={size}
        status={firstMember.status}
        className={cn("rakazo-group-avatar", className)}
      />
    );
  }

  // The reference's layout: two members at two thirds of the box, corner to corner; three or four
  // at five ninths. Each member is cut where a later one overlaps it, so the surface shows
  // between them; nothing is shaded.
  const shown = members.slice(0, MAX_MEMBERS);
  const places = groupPlaces(shown.length, size);
  const gap = (2 * size) / 36;
  return (
    <div
      className={cn("rakazo-group-avatar relative select-none", className)}
      style={{ width: size, height: size, flex: "none" }}
    >
      {shown.map((member, index) => {
        const place = places[index]!;
        const holes: AvatarCutoutHole[] = [];
        for (let later = index + 1; later < shown.length; later += 1) {
          const other = places[later]!;
          const reach = Math.hypot(
            place.x + place.size / 2 - (other.x + other.size / 2),
            place.y + place.size / 2 - (other.y + other.size / 2),
          );
          if (reach >= place.size / 2 + other.size / 2 + gap) continue;
          holes.push({
            x: other.x - place.x,
            y: other.y - place.y,
            width: other.size,
            height: other.size,
            shape: memberShape(shown[later]!, looks) ?? undefined,
          });
        }
        return (
          <div
            key={member.botId ?? index}
            className="absolute flex"
            style={{
              left: place.x,
              top: place.y,
              ...avatarCutoutStyle(place.size, holes, gap),
            }}
          >
            <BotAvatar
              color={member.color}
              avatarSet={member.avatarSet}
              identity={member.botId ?? member.name}
              size={place.size}
              status={member.status}
            />
          </div>
        );
      })}
    </div>
  );
});
