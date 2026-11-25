import { Trans } from "@lingui/react/macro";
import { useCloudAccounts } from "../accounts/cloud-accounts-context";
import { CloudPage, SuperbotMark } from "./CloudPage";

/** Signing in to the hosted site: the mark and the account service's own form. */
export function CloudSignInPage() {
  const { SignIn } = useCloudAccounts();
  return (
    <CloudPage data-testid="cloud-sign-in">
      <div className="flex w-full max-w-[460px] flex-col items-center">
        <SuperbotMark />
        <h1 className="sr-only">
          <Trans>Sign in to Superbot</Trans>
        </h1>
        <div className="mt-7 flex w-full justify-center">
          <SignIn />
        </div>
      </div>
    </CloudPage>
  );
}
