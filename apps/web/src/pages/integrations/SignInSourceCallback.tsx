import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";

export const SIGN_IN_SOURCE_CALLBACK_PATH = "/sign-in-source/callback";

/**
 * Where a password manager sends the person back after they approve the connection. Some
 * providers put part of the connection in the address's fragment, which never reaches a server
 * and is sent only once: it is read here, wiped from the address bar, and handed to the server.
 */
export function SignInSourceCallbackPage({ signedIn }: { signedIn: boolean }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !signedIn) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    const fragment = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
    // Off the address bar and out of history before anything else runs.
    window.history.replaceState(null, "", window.location.pathname);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(t`The connection was cancelled.`);
      return;
    }
    void rpc.signInSource
      .finishConnect({ code, state, fragment })
      .then(() => setDone(true))
      .catch((failure: unknown) => setError(errorText(failure, t`Couldn't finish connecting`)));
  }, [signedIn, t]);
  return (
    <div
      data-testid="sign-in-source-callback"
      className="grid min-h-screen place-items-center bg-background p-6 text-center"
    >
      <div>
        <div className="text-heading3 text-foreground">
          {!signedIn ? (
            <Trans>Sign in to finish connecting</Trans>
          ) : error ? (
            <Trans>Couldn't connect</Trans>
          ) : done ? (
            <Trans>Connected</Trans>
          ) : (
            <Trans>Finishing connection…</Trans>
          )}
        </div>
        {error ? <p className="mt-2 max-w-md text-body text-muted-foreground">{error}</p> : null}
        {!signedIn ? (
          <p className="mt-2 max-w-md text-body text-muted-foreground">
            <Trans>Sign in to Superbot in this browser, then connect again.</Trans>
          </p>
        ) : done || error ? (
          <Button type="button" className="mt-5" onClick={() => navigate("/app")}>
            <Trans>Return to Superbot</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
