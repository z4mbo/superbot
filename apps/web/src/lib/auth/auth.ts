import { passkeyClient } from "@better-auth/passkey/client";
import { SIGNUP_SURFACE_HEADER } from "@rakazo/contracts";
import { rememberSignupAttribution } from "@rakazo/core/signup-attribution";
import type { OrganizationClientOptions } from "better-auth/client/plugins";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import type { ReactAuthClient } from "better-auth/react";
import { createAuthClient } from "better-auth/react";
import { CLOUD_WEB } from "../../cloud/cloud-mode";
import { apiFetch, apiOrigin } from "../api/api-origin";
import { desktopBridge } from "../platform/desktop";

const signupSurface = desktopBridge() ? "desktop" : "web";
if (typeof window !== "undefined") rememberSignupAttribution(window);

export const authClient: ReactAuthClient<{
  // An uninstantiated generic resolves to `any`, which would erase every plugin's actions.
  plugins: [
    ReturnType<typeof organizationClient<OrganizationClientOptions>>,
    ReturnType<typeof emailOTPClient>,
    ReturnType<typeof passkeyClient>,
  ];
}> = CLOUD_WEB
  ? // The hosted page asks the workspace it is connected to, with the account token, not a cookie.
    createAuthClient({
      baseURL: apiOrigin(),
      fetchOptions: {
        headers: { [SIGNUP_SURFACE_HEADER]: signupSurface },
        customFetchImpl: apiFetch,
      },
      plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
    })
  : createAuthClient({
      fetchOptions: {
        headers: { [SIGNUP_SURFACE_HEADER]: signupSurface },
      },
      plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
    });
