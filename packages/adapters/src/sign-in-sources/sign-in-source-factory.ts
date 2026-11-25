import type { SignInSourceProvider } from "@rakazo/adapter-kit";
import { EmulatorSignInSourceProvider } from "./sign-in-source-emulator.js";

export type SignInSourceProviderKind = "none" | "onepassword" | "emulator";

/** Blank or unknown values become none, so the API still boots and the sign_in tool stays hidden. */
export function resolveSignInSourceProvider(
  source: NodeJS.ProcessEnv = process.env,
): SignInSourceProviderKind {
  const requested = source.SIGN_IN_SOURCE_PROVIDER?.trim().toLowerCase();
  return requested === "onepassword" || requested === "emulator" ? requested : "none";
}

/**
 * The deployment's sign-in source. A vendor's provider loads on demand, so deployments without it
 * never load its code; without a client registration it is listed but cannot be connected.
 */
export async function createSignInSourceProvider(
  source: NodeJS.ProcessEnv = process.env,
): Promise<SignInSourceProvider | null> {
  const kind = resolveSignInSourceProvider(source);
  if (kind === "emulator") return new EmulatorSignInSourceProvider();
  if (kind !== "onepassword") return null;
  const { OnePasswordSignInSource } = await import(
    "../providers/sign-in-source/onepassword/onepassword-sign-in-source.js"
  );
  const clientId = source.SIGN_IN_SOURCE_CLIENT_ID?.trim();
  const clientSecret = source.SIGN_IN_SOURCE_CLIENT_SECRET?.trim();
  return new OnePasswordSignInSource(clientId && clientSecret ? { clientId, clientSecret } : {});
}
