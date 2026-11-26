import * as z from "zod";

/** A key: letters, digits and underscores, never one that reaches an object's prototype. */
export const APP_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const APP_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** A state path: dot-separated keys, never one that reaches an object's prototype. */
export const appStatePathSchema = z
  .string()
  .max(200)
  .refine(
    (path) => path.split(".").every((key) => APP_KEY.test(key) && !APP_FORBIDDEN_KEYS.has(key)),
    "A state path is dot-separated keys of letters, digits and underscores.",
  );

/** The name of an input, a field, an action or a collection. */
export const appNameSchema = z
  .string()
  .regex(APP_KEY)
  .refine((name) => !APP_FORBIDDEN_KEYS.has(name), "That name is reserved.");

/**
 * One typed value: an action's input, a card's input or a stored record's field. Only plain
 * values, so a bot, a control and a function send and keep the same thing.
 */
export const appActionInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
    enum: z.array(z.string().max(200)).min(1).max(50).optional(),
  }),
  z.strictObject({
    type: z.literal("number"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
  }),
]);
export type AppActionInput = z.infer<typeof appActionInputSchema>;

/** The most inputs an action or a card takes, and fields a collection declares. */
export const APP_ACTION_INPUTS_MAX = 16;

/** Named typed values, as an action's or a card's `input` declares them. */
export function appFieldsSchema(max: number, what: string) {
  return z
    .record(appNameSchema, appActionInputSchema)
    .refine((fields) => Object.keys(fields).length <= max, {
      message: `${what} at most ${max}.`,
    });
}
