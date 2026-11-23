import { useLingui } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Check, ChevronDown, Server, UserPlus } from "lucide-react";
import { useState } from "react";
import { desktopBridge } from "../../../lib/platform/desktop";

const ROW =
  "flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-start text-body-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:text-placeholder";

/**
 * The workspace this chat lives in, inside the chat's capsule: its menu switches workspace,
 * invites people to it, and, in the desktop app, connects to another Superbot server.
 */
export function CapsuleWorkspacePicker({
  spaces,
  currentSpaceId,
  onSwitch,
  onInvite,
}: {
  spaces: readonly Pick<Space, "id" | "name" | "bots">[];
  currentSpaceId: string | undefined;
  onSwitch: (spaceId: string, path: string) => void;
  onInvite: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const current = spaces.find((space) => space.id === currentSpaceId);
  if (!current) return null;
  const server = desktopBridge()?.server;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="capsule-workspace"
        aria-label={t`Workspace: ${current.name}`}
        className="flex h-7 min-w-0 max-w-40 items-center gap-1 rounded-full px-2 text-body-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent"
      >
        <span className="min-w-0 truncate">{current.name}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          side="bottom"
          align="center"
          sideOffset={8}
          className="w-60 gap-0.5 rounded-2xl p-1.5 shadow-popover"
        >
          {spaces.map((space) => {
            const selected = space.id === current.id;
            const firstBot = space.bots[0];
            return (
              <button
                key={space.id}
                type="button"
                aria-current={selected ? "true" : undefined}
                className={ROW}
                onClick={() => {
                  setOpen(false);
                  if (!selected)
                    onSwitch(space.id, firstBot ? `/app/${firstBot.id}` : "/onboarding");
                }}
              >
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            );
          })}
          <div className="my-1 border-t border-hairline" />
          <button
            type="button"
            className={ROW}
            onClick={() => {
              setOpen(false);
              onInvite(current.id);
            }}
          >
            <UserPlus className="size-4 shrink-0 text-faint-foreground" aria-hidden="true" />
            {t`Invite people`}
          </button>
          {/* Connecting to another server swaps the whole app, which only the desktop app can do. */}
          <button
            type="button"
            className={ROW}
            disabled={!server}
            onClick={() => {
              setOpen(false);
              void server?.change();
            }}
          >
            <Server className="size-4 shrink-0 text-faint-foreground" aria-hidden="true" />
            {t`Connect to a server`}
          </button>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
