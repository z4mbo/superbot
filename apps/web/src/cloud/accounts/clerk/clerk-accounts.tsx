import { ClerkProvider, getToken, SignIn, useClerk, useUser } from "@clerk/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo } from "react";
import type { CloudAccountState, CloudAccounts } from "../cloud-accounts";
import { clerkAppearance } from "./clerk-appearance";
import { issuerFromPublishableKey } from "./clerk-issuer";

type LoadedClerk = ReturnType<typeof useClerk>;

/** Public by design: it names the instance, nothing more. Set once, by `createClerkAccounts`. */
let publishableKey = "";

// Calls made outside React (requests, sign-out, the workspace list) wait for the loaded SDK.
let resolveClerk: (clerk: LoadedClerk) => void = () => {};
const clerkReady = new Promise<LoadedClerk>((resolve) => {
  resolveClerk = resolve;
});

function ShareLoadedClerk() {
  const clerk = useClerk();
  const { isLoaded } = useUser();
  useLayoutEffect(() => {
    if (isLoaded) resolveClerk(clerk);
  }, [clerk, isLoaded]);
  return null;
}

function Provider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      afterSignOutUrl="/"
      appearance={clerkAppearance}
      telemetry={false}
    >
      <ShareLoadedClerk />
      {children}
    </ClerkProvider>
  );
}

function CloudSignIn() {
  // Hash routing keeps every step of the form on this page, so the static host needs no routes.
  // A new address signs up in the same form.
  return <SignIn routing="hash" withSignUp fallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" />;
}

function useAccount(): CloudAccountState {
  const { isLoaded, user } = useUser();
  return useMemo((): CloudAccountState => {
    if (!isLoaded) return { status: "loading" };
    if (!user) return { status: "signed-out" };
    return {
      status: "signed-in",
      user: {
        id: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? null,
        name: user.fullName || null,
        imageUrl: user.hasImage ? user.imageUrl : null,
      },
    };
  }, [isLoaded, user]);
}

/** The signed-in user as the service has it now, so another tab's edit is not overwritten. */
async function freshUser() {
  const { user } = await clerkReady;
  if (!user) throw new Error("Not signed in to the account service");
  return user.reload();
}

/**
 * The account service backed by Clerk: the only module that loads its SDK, while the rest of the
 * app sees `CloudAccounts`.
 */
export function createClerkAccounts(key: string | undefined): CloudAccounts {
  const issuer = issuerFromPublishableKey(key);
  if (!key || !issuer) {
    throw new Error(
      "The hosted build needs VITE_CLERK_PUBLISHABLE_KEY, the account service's publishable key (pk_test_… or pk_live_…). Set it in the build environment and build again.",
    );
  }
  publishableKey = key.trim();
  return {
    issuer,
    Provider,
    SignIn: CloudSignIn,
    useAccount,
    // The default session token: short-lived, cached and renewed by the SDK, and works outside React.
    getToken: () => getToken(),
    async signOut() {
      await (await clerkReady).signOut();
    },
    async readDocument(name) {
      const user = await freshUser();
      return user.unsafeMetadata[name] ?? null;
    },
    async writeDocument(name, value) {
      const user = await freshUser();
      await user.update({ unsafeMetadata: { ...user.unsafeMetadata, [name]: value } });
    },
  };
}
