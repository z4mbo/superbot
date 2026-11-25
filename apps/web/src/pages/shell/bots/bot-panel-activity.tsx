import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ChevronRight, Plus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { ROUTINE_PREVIEW_COUNT, RoutineList } from "../../routines/RoutineList";
import { PanelCardSection } from "./bot-panel-card";

/**
 * The bot panel's Activity tab: what is coming up, then its computer. Each section is a plain
 * sibling, so another one slots in with a single line.
 */
export function BotPanelActivity({
  routines,
  onOpenRoutines,
  computer,
  children,
}: {
  routines?: Omit<ComponentProps<typeof RoutineList>, "preview">;
  /** Opens the whole routine list. */
  onOpenRoutines: () => void;
  computer?: ReactNode;
  /** Shown after the sections. */
  children?: ReactNode;
}) {
  return (
    <div data-testid="bot-panel-activity" className="flex flex-col gap-6">
      {routines ? <UpcomingSection routines={routines} onOpenAll={onOpenRoutines} /> : null}
      {computer ? (
        <PanelCardSection label={<Trans>Computer</Trans>} testId="bot-panel-computer">
          {computer}
        </PanelCardSection>
      ) : null}
      {children}
    </div>
  );
}

/** The bot's routines, soonest first, each with its schedule and a switch. */
function UpcomingSection({
  routines,
  onOpenAll,
}: {
  routines: Omit<ComponentProps<typeof RoutineList>, "preview">;
  onOpenAll: () => void;
}) {
  const { t } = useLingui();
  const count = routines.routines.length;
  return (
    <PanelCardSection
      testId="bot-panel-upcoming"
      label={
        count > ROUTINE_PREVIEW_COUNT ? (
          <button
            type="button"
            onClick={onOpenAll}
            className="flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trans>Upcoming</Trans>
            <ChevronRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
          </button>
        ) : (
          <Trans>Upcoming</Trans>
        )
      }
      action={
        count > 0 ? (
          <Button
            variant="ghost"
            size="icon-xs"
            data-testid="routine-create-button"
            aria-label={t`Create routine`}
            onClick={routines.onCreate}
          >
            <Plus className="size-4" />
          </Button>
        ) : null
      }
    >
      <RoutineList {...routines} preview />
    </PanelCardSection>
  );
}
