import { Trans, useLingui } from "@lingui/react/macro";
import type { PlanLimitWindow, ProviderCredits, ProviderUsage } from "@rakazo/contracts";
import { providerUsagePercent, tightestProviderUsageFirst } from "@rakazo/contracts";
import { formatTimeUntil, modelMark } from "@rakazo/core";
import { Button, Progress, SectionHeading, toast } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useFormatUsd, usePeriodLabel } from "../../../components/billing/PlanUsage";
import { ModelMarkIcon } from "../../../components/models/ModelMarkIcon";
import { sidebarUsageExpandedPreference } from "../../../lib/preferences/sidebar-usage-pref";
import { useQueryUserId, useSave, useSpaceQueries } from "../../../lib/query/query";

/** From this share used, a figure reads as running low. */
const WARN_PERCENT = 80;

const revealRequests = new Set<() => void>();

/** Opens the sidebar's usage section in detail and moves focus to it, as the model list asks. */
export function revealSidebarUsage() {
  for (const reveal of revealRequests) reveal();
}

/**
 * Every model connection's usage as its provider reports it. The server keeps a recent reading,
 * so this reads once per minute at most and never polls.
 */
export function useProviderUsage({ enabled = true }: { enabled?: boolean } = {}) {
  const queries = useSpaceQueries();
  return useQuery({
    ...queries.usage.providers.queryOptions(),
    staleTime: 60_000,
    refetchOnMount: true,
    enabled,
  });
}

/** The section at the bottom of the bots sidebar: each connection's limits, one line or in detail. */
export function SidebarUsage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const usage = useProviderUsage();
  const preference = sidebarUsageExpandedPreference(userId);
  const expanded = preference.use();
  const listId = useId();
  const header = useRef<HTMLButtonElement>(null);
  const [revealed, setRevealed] = useState(0);
  const refresh = useSave({
    save: (_, client) => client.usage.providers({ refresh: true }),
    onSaved: (rows) => queryClient.setQueryData(queries.usage.providers.queryKey(), rows),
    onFailed: () => toast.error(t`Couldn't load usage`),
  });

  useEffect(() => {
    const reveal = () => {
      preference.set(true);
      setRevealed((count) => count + 1);
    };
    revealRequests.add(reveal);
    return () => {
      revealRequests.delete(reveal);
    };
  }, [preference]);
  useEffect(() => {
    if (!revealed) return;
    // After the model list has closed and handed focus back to its button.
    const frame = requestAnimationFrame(() => {
      header.current?.scrollIntoView({ block: "nearest" });
      header.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [revealed]);

  const rows = usage.data ? tightestProviderUsageFirst(usage.data) : undefined;
  if (rows && !rows.length) return null;
  const names = new Map<string, number>();
  for (const row of rows ?? []) names.set(row.name, (names.get(row.name) ?? 0) + 1);
  const shared = (row: ProviderUsage) => (names.get(row.name) ?? 0) > 1;

  return (
    <section data-testid="sidebar-usage" className="flex shrink-0 flex-col px-2.5 pb-1">
      <div className="flex items-center gap-1">
        <SectionHeading variant="label" className="min-w-0 flex-1">
          <button
            ref={header}
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => preference.set(!expanded)}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trans>Usage</Trans>
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        </SectionHeading>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Refresh usage`}
          disabled={refresh.pending || usage.isPending}
          onClick={() => refresh.run()}
          className="text-muted-foreground"
        >
          <RefreshCw aria-hidden="true" className={refresh.pending ? "animate-spin" : undefined} />
        </Button>
      </div>
      <div id={listId} className="rk-scroll flex max-h-[30vh] flex-col overflow-y-auto">
        {!rows ? (
          <p className="px-2.5 py-1 text-body-sm text-muted-foreground">
            {usage.isError ? t`Couldn't load usage` : t`Loading usage…`}
          </p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) =>
              expanded ? (
                <DetailedRow key={row.credentialId} row={row} shared={shared(row)} />
              ) : (
                <CompactRow key={row.credentialId} row={row} shared={shared(row)} />
              ),
            )}
          </ul>
        )}
        {expanded && rows ? (
          <Button variant="ghost" size="xs" className="mt-1 self-start" onClick={onOpenSettings}>
            <Trans>Usage details</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A connection's mark and name, with its own name only when another connection shares the name,
 * and its plan in the detailed view.
 */
function ConnectionName({
  row,
  shared,
  plan = false,
}: {
  row: ProviderUsage;
  shared: boolean;
  plan?: boolean;
}) {
  return (
    <>
      <ModelMarkIcon
        mark={modelMark({ provider: row.provider })}
        className="size-3.5 shrink-0 text-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
        {row.name}
        {shared ? <span className="ms-1.5 text-muted-foreground">{row.label}</span> : null}
        {plan && row.plan ? <span className="ms-1.5 text-muted-foreground">{row.plan}</span> : null}
      </span>
    </>
  );
}

function CompactRow({ row, shared }: { row: ProviderUsage; shared: boolean }) {
  const used = providerUsagePercent(row);
  const credits = useCreditFigure(row.credits, "compact");
  const status = useStatusText(row);
  return (
    <li
      data-testid="usage-row"
      className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-body-sm"
    >
      <ConnectionName row={row} shared={shared} />
      {used !== null ? (
        <Figure text={`${Math.round(used)}%`} percent={used} />
      ) : credits ? (
        <Figure text={credits.text} percent={credits.percent} />
      ) : (
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">{status}</span>
      )}
    </li>
  );
}

/** A figure at the end of a compact row, with a thin bar when it is a share of a limit. */
function Figure({ text, percent }: { text: string; percent: number | null }) {
  const { t } = useLingui();
  const warn = percent !== null && percent >= WARN_PERCENT;
  return (
    <>
      {percent !== null ? (
        <Progress
          value={Math.min(100, percent)}
          aria-hidden="true"
          className={`w-10 shrink-0 ${warn ? "[&_[data-slot=progress-indicator]]:bg-warning" : "[&_[data-slot=progress-indicator]]:bg-link"}`}
        />
      ) : null}
      <span
        className={`shrink-0 whitespace-nowrap tabular-nums ${warn ? "text-warning" : "text-foreground"}`}
      >
        {text}
        {warn ? <span className="sr-only">{` ${t`Running low`}`}</span> : null}
      </span>
    </>
  );
}

function DetailedRow({ row, shared }: { row: ProviderUsage; shared: boolean }) {
  const { t } = useLingui();
  const periodLabel = usePeriodLabel();
  const credits = useCreditFigure(row.credits, "detailed");
  const status = useStatusText(row);
  const creditsLabel = {
    day: t`Daily credits`,
    week: t`Weekly credits`,
    month: t`Monthly credits`,
  };
  const empty = !row.windows.length && !credits;
  return (
    <li data-testid="usage-row" className="flex flex-col gap-2 px-2.5 py-2">
      <div className="flex items-center gap-2 text-body-sm">
        <ConnectionName row={row} shared={shared} plan />
        {empty ? (
          <span className="shrink-0 whitespace-nowrap text-muted-foreground">{status}</span>
        ) : null}
      </div>
      {row.windows.map((window: PlanLimitWindow, index) => (
        <Allowance
          // A provider can report one period per model family.
          key={`${window.period}:${window.model ?? index}`}
          label={periodLabel(window.period)}
          model={window.model}
          text={`${Math.round(window.usedPercent)}%`}
          percent={window.usedPercent}
          resetsAt={window.resetsAt}
        />
      ))}
      {credits ? (
        <Allowance
          label={row.credits?.period ? creditsLabel[row.credits.period] : t`Credits`}
          text={credits.text}
          percent={credits.percent}
          resetsAt={row.credits?.resetsAt ?? null}
        />
      ) : null}
    </li>
  );
}

/** One allowance in detail: what it is, how much is used, and when it starts over. */
function Allowance({
  label,
  model,
  text,
  percent,
  resetsAt,
}: {
  label: string;
  /** The model family the allowance covers, when it covers only one. */
  model?: string;
  text: string;
  percent: number | null;
  resetsAt: string | null;
}) {
  const { t, i18n } = useLingui();
  const warn = percent !== null && percent >= WARN_PERCENT;
  const reset = formatTimeUntil(resetsAt, i18n.locale);
  return (
    <div className="min-w-0 ps-5.5">
      <div className="flex items-baseline justify-between gap-2 text-label">
        <span className="min-w-0 truncate text-muted-foreground">
          {label}
          {model ? <span className="ms-1.5 text-foreground/75">{model}</span> : null}
        </span>
        <span
          className={`shrink-0 whitespace-nowrap tabular-nums ${warn ? "text-warning" : "text-foreground"}`}
        >
          {text}
          {warn ? <span className="sr-only">{` ${t`Running low`}`}</span> : null}
        </span>
      </div>
      {percent !== null ? (
        <Progress
          value={Math.min(100, percent)}
          aria-label={model ? `${label} ${model}` : label}
          className={`mt-1 ${warn ? "[&_[data-slot=progress-indicator]]:bg-warning" : "[&_[data-slot=progress-indicator]]:bg-link"}`}
        />
      ) : null}
      {reset ? (
        <p className="mt-1 truncate text-caption text-muted-foreground">{t`Resets in ${reset}`}</p>
      ) : null}
    </div>
  );
}

/**
 * The money a provider reported, as words and, when it gave both a cap and the spending against
 * it, a share for a bar. Nothing reported reads as nothing, never as zero.
 */
function useCreditFigure(
  credits: ProviderCredits | null,
  form: "compact" | "detailed",
): { text: string; percent: number | null } | null {
  const { t } = useLingui();
  const usd = useFormatUsd();
  if (!credits) return null;
  const { usedUsd, limitUsd, remainingUsd } = credits;
  const capped = usedUsd !== null && limitUsd !== null && limitUsd > 0;
  const percent = capped ? (usedUsd / limitUsd) * 100 : null;
  if (capped && form === "detailed")
    return { text: t`${usd(usedUsd)} of ${usd(limitUsd)} used`, percent };
  if (remainingUsd !== null) return { text: t`${usd(remainingUsd)} left`, percent };
  if (usedUsd !== null) return { text: t`${usd(usedUsd)} used`, percent };
  return null;
}

/** Why a connection shows no figures. */
function useStatusText(row: ProviderUsage): string {
  const { t } = useLingui();
  switch (row.status) {
    case "unavailable":
      return t`Usage not available`;
    case "not_signed_in":
      return t`Not signed in`;
    case "error":
      return t`Couldn't load usage`;
    default:
      return t`No usage data`;
  }
}
