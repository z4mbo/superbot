/** Instructions the sign_in tool returns to the model. None of them ever carries a credential. */

export const SIGN_IN_GOAL = (site: string) => `Sign in to ${site} for the user`;

export const SIGN_IN_NOT_HTTPS = "site must be the sign-in page's HTTPS address.";

export const SIGN_IN_USE_VAULT_LOGIN = (name: string) =>
  `A login saved for this site is available: type it with browser_act fill_secret, secret "${name}". Don't call sign_in for this site.`;

export const SIGN_IN_NOT_CONNECTED = (label: string) =>
  `No password manager is connected. The chat now shows the user a card to connect ${label}; ask them to connect it, then call sign_in again. Never ask the user to type a password, code or username into the chat. If they'd rather save the login here, use request_secret.`;

export const SIGN_IN_NEEDS_RECONNECT = (label: string) =>
  `The connection to ${label} has expired. The chat shows the user a card to connect it again; ask them to, then call sign_in again. Never ask for the password in the chat.`;

export const SIGN_IN_FILL_UNAVAILABLE = (label: string) =>
  `This computer's browser can't fill logins from ${label} yet. Ask the user to sign in on the page themselves, or to save the login with request_secret. Never ask for the password in the chat.`;

export const SIGN_IN_NOT_REVIEWED = (label: string) =>
  `The user didn't open the request in ${label}, so it was closed. Call sign_in again when they are ready to approve it.`;

export const SIGN_IN_STILL_PENDING = (label: string) =>
  `The user hasn't approved the login in ${label} yet. Ask them whether they approved it, then call sign_in again.`;

export const SIGN_IN_DENIED = (label: string) =>
  `The user declined to share a login from ${label} for this site. Don't ask again unless they bring it up.`;

export const SIGN_IN_EXPIRED = (label: string) =>
  `The request in ${label} expired before the user answered. Call sign_in again if they still want you to sign in.`;

export const SIGN_IN_PROVIDER_FAILED = (label: string) =>
  `${label} couldn't handle the request. Try sign_in again later, or ask the user to sign in on the page themselves.`;

export const SIGN_IN_FILLED =
  "The approved login was filled and submitted. Take a browser_snapshot to check that the site signed you in; a login form or error still on the page means it did not.";

export const SIGN_IN_FILL_FAILED = (label: string) =>
  `${label} couldn't fill the login on this page. Navigate to the site's sign-in form and call sign_in again.`;
