/**
 * True in the hosted build (`VITE_SUPERBOT_CLOUD=1`): people sign in with a central account and
 * the app talks to their own servers across origins. False everywhere else, where the app talks to
 * the server that served it. A build-time constant, so the other mode's code is dropped.
 */
export const CLOUD_WEB: boolean = import.meta.env.VITE_SUPERBOT_CLOUD === "1";
