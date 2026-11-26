import { cn, SectionHeading } from "@rakazo/ui-web";
import type { ReactNode } from "react";

/** A hairline card holding a section's rows. */
export function PanelCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-hairline bg-card", className)}>
      {children}
    </div>
  );
}

/**
 * One section of the bot panel's tabs: a small muted heading, an optional control beside it,
 * then its card. Sections stack as plain siblings, so adding one is a single line.
 */
export function PanelCardSection({
  label,
  action,
  testId,
  children,
}: {
  label: ReactNode;
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId}>
      <SectionHeading
        variant="panel"
        className="mb-2 flex min-h-6 items-center justify-between gap-2 px-3"
      >
        {label}
        {action}
      </SectionHeading>
      <PanelCard>{children}</PanelCard>
    </section>
  );
}

/** A row inside a panel card: a label on the left and its control on the right. */
export function PanelCardRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-1.5 text-body text-foreground">
      {children}
    </div>
  );
}
