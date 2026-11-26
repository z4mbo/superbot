import { oc } from "@orpc/contract";
import * as z from "zod";
import { IsoDate } from "../ids.js";

/**
 * The person's connection to a sign-in source: a password manager that lets a bot sign in to a
 * website after the person approves the login in the password manager's own app.
 */
export const SignInSourceStateSchema = z.object({
  /** The provider's id, an opaque string. */
  id: z.string(),
  /** The provider's product name, from its descriptor. */
  label: z.string(),
  /** False while the server has no registration with the provider, so nobody can connect yet. */
  connectable: z.boolean(),
  status: z.enum(["disconnected", "connecting", "connected", "needs_reconnect"]),
  connectedAt: IsoDate.optional(),
});
export type SignInSourceState = z.infer<typeof SignInSourceStateSchema>;

export const SignInRequestStatus = z.enum([
  /** No sign-in source is connected; the card offers to connect one. */
  "needs_connection",
  "pending",
  "approved",
  "denied",
  "expired",
  "failed",
]);
export type SignInRequestStatus = z.infer<typeof SignInRequestStatus>;

/**
 * A bot asking to sign in to `site` with a login from the person's sign-in source. The approval
 * link is never stored on the card: the owner reads it with `signInSource.review`.
 */
export const SignInBlockSchema = z.object({
  kind: z.literal("sign_in"),
  /** The HTTPS origin the bot is signing in to. */
  site: z.string().max(2048),
  /** The sign-in source's product name when the card was made. */
  label: z.string().max(100),
  status: SignInRequestStatus,
  requestId: z.string().max(64).optional(),
  /** The person opened the review; only then is the provider asked for the answer. */
  opened: z.literal(true).optional(),
});
export type SignInBlock = z.infer<typeof SignInBlockSchema>;

/** The redirect page's parameters, as the provider sent them. */
export const SignInSourceFinishInput = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(512),
    /** The redirect's fragment parameters, which some providers send only on first consent. */
    fragment: z.record(z.string().max(64), z.string().max(8192)).optional(),
  })
  .strict();

export const signInSourceRpc = {
  /** The signed-in user's sign-in source; null when the deployment offers none. */
  signInSource: {
    status: oc.output(SignInSourceStateSchema.nullable()),
    /** Starts the provider's sign-in; the client opens `authorizeUrl`. */
    connect: oc.output(z.object({ authorizeUrl: z.string().url() })),
    /** Called by the redirect page with what the provider sent back. */
    finishConnect: oc.input(SignInSourceFinishInput).output(SignInSourceStateSchema),
    disconnect: oc.output(SignInSourceStateSchema),
    /**
     * The approval link for one of the user's pending requests, exactly as the provider returned
     * it. Reading it marks the request opened, which starts asking the provider for the answer.
     */
    review: oc
      .input(z.object({ requestId: z.string().min(1).max(64) }).strict())
      .output(z.object({ approvalLink: z.string() })),
  },
};
