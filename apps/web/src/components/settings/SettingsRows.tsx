import type { ReactNode } from "react";

export const SETTINGS_CONTENT_WIDTH = "max-w-[640px]";

/** A settings row's combobox, with `size="sm"`: the row's small type and a snug inset. */
export const SETTINGS_SELECT_CLASS = "gap-1 pr-[5px] pl-[7px] text-body-sm [&_svg]:size-3";

/** A titled list of settings rows sharing one bordered surface. */
export function SettingsGroup({
  title,
  action,
  children,
  "data-testid": testId,
}: {
  title?: ReactNode;
  /** One control for the whole group, at the end of its title. */
  action?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section data-testid={testId}>
      {title ? (
        <div className="mb-2 flex items-center justify-between gap-3 px-3.5">
          <h3 className="text-label font-normal text-muted-foreground">{title}</h3>
          {action}
        </div>
      ) : null}
      <div className="rounded-[14px] border border-hairline bg-card py-2">{children}</div>
    </section>
  );
}

/** One setting: label then control, side by side when they fit, optional detail below. */
export function SettingsRow({
  label,
  control,
  children,
}: {
  label: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-slot="settings-row" className="px-3.5 py-2.5">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-body-sm text-foreground">{label}</div>
        {control ? (
          <div className="flex max-w-full min-w-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
