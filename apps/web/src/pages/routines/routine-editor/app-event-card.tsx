import { Trans, useLingui } from "@lingui/react/macro";
import type { AppEventSource } from "@rakazo/contracts";
import { Button, Field, FieldGroup, FieldLabel, Input, OptionSelect } from "@rakazo/ui-web";
import { X, Zap } from "lucide-react";
import { useId } from "react";
import type { RoutineAppEventDraft } from "../../../lib/routines/routine-draft";

/** A new app event: the first event of the first app the person has connected. */
export function newAppEventDraft(source: AppEventSource): RoutineAppEventDraft | null {
  const event = source.events[0];
  const connection = source.connections[0];
  if (!event || !connection) return null;
  return { app: source.app, event: event.id, connectionId: connection.id, params: {} };
}

export function AppEventTriggerCard({
  value,
  sources,
  onChange,
  onRemove,
}: {
  value: RoutineAppEventDraft;
  sources: readonly AppEventSource[];
  onChange: (next: RoutineAppEventDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const source =
    sources.find(
      (candidate) =>
        candidate.app === value.app &&
        candidate.connections.some((connection) => connection.id === value.connectionId),
    ) ?? sources.find((candidate) => candidate.app === value.app);
  const event = source?.events.find((candidate) => candidate.id === value.event);
  const title = source && event ? `${source.name}: ${event.label}` : (value.label ?? t`App event`);
  // The account it came from may have been removed: then only its label and what to do are left.
  const connected = Boolean(source?.connections.some((c) => c.id === value.connectionId));

  return (
    <div className="rounded-xl border border-border p-3" data-testid="routine-app-event-card">
      <div className="flex items-center gap-2.5 px-0.5">
        <Zap size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">{title}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove app event`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {source && event && connected ? (
        <FieldGroup className="mt-3 gap-3">
          {sources.length > 1 ? (
            <Field>
              <FieldLabel htmlFor={`${id}-app`}>
                <Trans>App</Trans>
              </FieldLabel>
              <OptionSelect
                id={`${id}-app`}
                value={`${source.app}\u0000${value.connectionId}`}
                options={sources.flatMap((candidate) =>
                  candidate.connections.map((connection) => ({
                    value: `${candidate.app}\u0000${connection.id}`,
                    label: connection.name,
                  })),
                )}
                onValueChange={(choice) => {
                  const [app, connectionId] = choice.split("\u0000");
                  const next = sources.find((candidate) => candidate.app === app);
                  const first = next?.events[0];
                  if (!next || !first || !connectionId) return;
                  onChange({ app: next.app, event: first.id, connectionId, params: {} });
                }}
              />
            </Field>
          ) : source.connections.length > 1 ? (
            <Field>
              <FieldLabel htmlFor={`${id}-account`}>
                <Trans>Account</Trans>
              </FieldLabel>
              <OptionSelect
                id={`${id}-account`}
                value={value.connectionId}
                options={source.connections.map((connection) => ({
                  value: connection.id,
                  label: connection.name,
                }))}
                onValueChange={(connectionId) => onChange({ ...value, connectionId })}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${id}-event`}>
              <Trans>Event</Trans>
            </FieldLabel>
            <OptionSelect
              id={`${id}-event`}
              value={value.event}
              options={source.events.map((candidate) => ({
                value: candidate.id,
                label: candidate.label,
              }))}
              onValueChange={(next) => onChange({ ...value, event: next, params: {} })}
            />
          </Field>
          {event.params.map((param) => (
            <Field key={param.key}>
              <FieldLabel htmlFor={`${id}-${param.key}`}>{param.label}</FieldLabel>
              <Input
                id={`${id}-${param.key}`}
                value={value.params[param.key] ?? ""}
                placeholder={param.placeholder}
                required={!param.optional}
                onChange={(e) =>
                  onChange({ ...value, params: { ...value.params, [param.key]: e.target.value } })
                }
              />
            </Field>
          ))}
        </FieldGroup>
      ) : null}
      {value.error ? (
        <p role="status" className="mt-3 text-body-sm text-destructive">
          {value.error}
        </p>
      ) : value.checked ? (
        <p className="mt-3 text-body-sm text-muted-foreground">
          <Trans>Checked every 5 minutes</Trans>
        </p>
      ) : null}
    </div>
  );
}
