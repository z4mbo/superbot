import * as z from "zod";
import { Id } from "../ids.js";

/**
 * A routine that starts on an event from a connected app, such as a new issue in a repository.
 * The integration provider declares which events each app can emit; `app` and `event` are its
 * ids, opaque to everything but the provider.
 */
export const ROUTINE_APP_EVENTS_MAX = 5;
const APP_EVENT_PARAMS_MAX = 10;

export const RoutineAppEventInputSchema = z.object({
  app: z.string().trim().min(1).max(100),
  event: z.string().trim().min(1).max(200),
  /** The connected account the event comes from. */
  connectionId: Id,
  params: z
    .record(z.string().trim().min(1).max(100), z.string().trim().max(500))
    .refine((params) => Object.keys(params).length <= APP_EVENT_PARAMS_MAX, {
      message: "Too many event settings",
    })
    .default({}),
});
export type RoutineAppEventInput = z.input<typeof RoutineAppEventInputSchema>;

export const RoutineAppEventsInputSchema = z
  .array(RoutineAppEventInputSchema)
  .max(ROUTINE_APP_EVENTS_MAX);

/** A routine's app event as clients show it. */
export const RoutineAppEventSchema = RoutineAppEventInputSchema.extend({
  /** What starts it, in words: "GitHub: New issue". */
  label: z.string(),
  /** True when it is seen by a change check rather than pushed by the provider. */
  checked: z.boolean(),
  /** Why the provider is not delivering it, for the owner to fix. */
  error: z.string().nullable(),
});
export type RoutineAppEvent = z.infer<typeof RoutineAppEventSchema>;

/** One app the viewer has connected and the events it can start a routine with. */
export const AppEventSourceSchema = z.object({
  app: z.string(),
  name: z.string(),
  connections: z.array(z.object({ id: Id, name: z.string() })),
  events: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      params: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          placeholder: z.string().optional(),
          optional: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
export type AppEventSource = z.infer<typeof AppEventSourceSchema>;
