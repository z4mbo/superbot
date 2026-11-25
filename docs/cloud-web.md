# Superbot Cloud web

Superbot Cloud web is the web app hosted once, on a static host, for everyone. A person signs in there with a Superbot account and connects the page to their **workspaces**: their own Superbot servers, each one a URL. The page talks to those servers straight from the browser. A workspace whose server does not answer shows as offline.

Self-hosting is unchanged. A server still serves its own web app, the desktop app still opens it, and nothing here is on unless the operator turns it on.

## How the pieces fit today

- `apps/web` is a Vite single-page app. Its server (`apps/web/server`, `vite preview` in the containers) serves the built files and forwards `/api`, `/rpc` and two `.well-known` paths to `apps/api`. The page therefore calls its own origin: `rpc.ts` uses `${window.location.origin}/rpc`, and the auth client and every raw `fetch("/api/…")` are relative.
- `apps/api` (Hono) signs people in with Better Auth. The browser holds a session cookie. Native clients hold no cookie: they send `Authorization: Bearer <signed session token>`, which the bearer plugin turns into the same session. The mobile app already connects to any server URL this way.
- Live updates are oRPC event streams read with `fetch`, not `EventSource` or WebSockets, so a request header authenticates them too. The one WebSocket (`/api/user-devices/connect`) belongs to the desktop app's own computer and is not used by the hosted page.
- `apps/worker` runs jobs and is not reached by clients.
- The Electron desktop app opens the web app from the server it is pointed at, same origin, and is not affected.

## Design

### The hosted build

`VITE_SUPERBOT_CLOUD=1` builds the same app in cloud mode (`apps/web/src/cloud/cloud-mode.ts`). It is a build-time constant, so a self-hosted build contains none of the cloud code or its account SDK and behaves exactly as before. In cloud mode:

- The entry mounts a gate in front of the app (`apps/web/src/cloud/ui/CloudGate.tsx`): sign-in when signed out, the workspace list when none is chosen, an unavailable state when the chosen server cannot be used, and the unchanged app once it can.
- Every API call goes to the active workspace's origin instead of the page's, without cookies, with `Authorization: Bearer <account token>`.
- The Superbot theme (Inter, the Grok Bot look) is written into the build, because no server is there to serve `/instance-theme.css`.
- Switching workspace reloads the page, so no query, stream or cached data from one server survives into another. The active workspace is kept in the browser's local storage and read before anything renders.

Not available from the hosted page in this version, because they need the server's own web origin: the computer screen viewer (its proxy lives in the web server), passkeys and the other local sign-in methods (the server account is chosen by the cloud account instead), and the `/welcome/` site.

### Accounts

Accounts live in Clerk. The hosted site needs no database and no secret for this version: the browser signs in with the publishable key, Google sign-in works out of the box, and Clerk Billing is there when hosted plans arrive. A later Vercel function can use `CLERK_SECRET_KEY` for anything that must not be decided in the browser; nothing depends on it now.

The Clerk SDK is loaded only by `apps/web/src/cloud/accounts/clerk/`. Everything else uses the `CloudAccounts` interface (`cloud-accounts.ts`): a provider, a sign-in form, the account state, `getToken()`, `signOut()` and a small per-account document store.

The instance's session token carries three custom claims, set once in Clerk (Sessions → Customize session token):

```json
{
  "email": "{{user.primary_email_address}}",
  "email_verified": "{{user.email_verified}}",
  "name": "{{user.full_name}}"
}
```

A server reads the account's email from the token, so it needs no Clerk secret and makes no call to Clerk besides fetching the public signing keys.

### Workspaces

A workspace is `{ id, name, url, kind, addedAt }`, where `kind` is `"self-hosted"` today and `"hosted"` is reserved for servers we will run. The list is read and written through the `WorkspaceDirectory` interface. In this version it is stored in the Clerk user's `unsafeMetadata.workspaces`, which the browser can update itself. That is acceptable because the list grants nothing: a server decides who may sign in, so a tampered list can only point a person's own browser at a server that will refuse them. It moves behind a function and a database when hosted workspaces need a list the person cannot edit.

A workspace URL must be an origin with no path. `https` is required, except `http://localhost` and loopback addresses for development.

### How a request is authenticated

1. The page asks the account service for a token before each request. Clerk's session token is an RS256 JWT that lives 60 seconds; `getToken()` returns a cached one and renews it in the background.
2. The page sends it to the workspace: `Authorization: Bearer <JWT>`, no cookies.
3. The server verifies it: signature against the issuer's JWKS (fetched from `<issuer>/.well-known/jwks.json`, cached, refetched at most once a minute for an unknown key id), `iss` equal to the configured issuer, `exp` and `nbf` with a few seconds of skew, and `azp` (the origin the token was issued to) allowed by `SUPERBOT_CLOUD_WEB_ORIGINS`.
4. It maps the account to a local one. The token must carry a verified `email` that the operator listed in `SUPERBOT_CLOUD_ALLOWED_EMAILS`. An entry is `cloud@example.com` (the local account with the same email; on a server with a single account, that account) or `cloud@example.com=local@example.com` (a named local account). No account is created.
5. It signs the request in as that local account by attaching a local session and continuing through the ordinary session path, so RPC, streams, uploads and Better Auth's own routes behave as for any signed-in client. A refused token answers `401 { "code": … }` with one of `token_invalid`, `email_unverified`, `account_not_allowed`, `no_local_account`.

The browser never holds a long-lived credential for a server. Ending the cloud session stops new requests within a minute.

This differs from the brief in one place: the brief named `SUPERBOT_CLOUD_CLERK_ISSUER`. The server setting is `SUPERBOT_CLOUD_ISSUER`, because the server only does standard JWT verification against an issuer and its JWKS, and this repository keeps vendor names out of server settings. Any issuer whose tokens carry `azp`, `email` and `email_verified` works.

### Server settings

All off by default. Setting some but not all of the first three is a startup error, so a half-configured server never accepts tokens.

| Variable                        | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPERBOT_CLOUD_WEB_ORIGINS`    | Comma-separated origins of the hosted site allowed to call this server, e.g. `https://superbot-web.vercel.app`. One `*` may stand for part of the first host label after a fixed prefix, e.g. `https://superbot-web-*.vercel.app`, for preview deployments. Use exact origins in production: anyone can register an unclaimed name under a shared suffix. |
| `SUPERBOT_CLOUD_ISSUER`         | The account issuer, e.g. `https://fresh-midge-6799.clerk.accounts.dev`.                                                                                                                                                                                                                                                                                   |
| `SUPERBOT_CLOUD_ALLOWED_EMAILS` | Comma-separated accounts that may sign in, each `email` or `email=local-email`.                                                                                                                                                                                                                                                                           |
| `SUPERBOT_CLOUD_JWKS_URL`       | Optional. Defaults to `<issuer>/.well-known/jwks.json`.                                                                                                                                                                                                                                                                                                   |
| `SUPERBOT_CLOUD_SERVER_NAME`    | Optional. The name the health answer reports. Defaults to `Superbot`.                                                                                                                                                                                                                                                                                     |

With these set, the API:

- answers CORS for the allowed origins on every route, including preflight, allowing the `Authorization` header and without `Access-Control-Allow-Credentials`, so a cookie is never accepted from the hosted site;
- answers `Access-Control-Allow-Private-Network: true` on preflights that ask for it, for servers on a private or tailnet address;
- serves `GET /api/health` → `{ ok, name, version, cloudEnabled, cloudApi }` and `GET /api/cloud/session` → `{ user }` or a refusal.

### Online and offline

The page probes each workspace every 15 seconds, when the window regains focus and on demand, with a 5 second timeout:

| What happens                                                                      | Shown as                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/api/health` answers, `cloudApi` matches, `/api/cloud/session` accepts the token | online                                                                                               |
| `/api/health` answers with another `cloudApi`                                     | incompatible                                                                                         |
| `/api/health` answers, `/api/cloud/session` refuses                               | unauthorized, with the reason and the setting to change                                              |
| `/api/health` fails, but an opaque `no-cors` request to the same URL succeeds     | not set up for this site, with the settings to add; offline if this browser has had it online before |
| nothing answers                                                                   | offline                                                                                              |

The `no-cors` probe matters because a server that has not listed the site sends no CORS headers, which a normal `fetch` cannot tell apart from a dead server. An opaque answer cannot be read either, so a reverse proxy's error page for a stopped server looks the same as a server that never listed the site. The page therefore remembers, in the browser, which workspaces it has had online: for those an unreadable answer means offline, and only a workspace that never connected is shown as not set up. When the active workspace is not online the page shows that state with a retry and a way to switch, instead of a broken app.

### Private and tailnet servers

A browser reaches a server only if the device it runs on can. For a server on a tailnet (`https://<host>.<tailnet>.ts.net`):

- **(a) The browser's device is on the tailnet.** Works today. Chromium treats tailnet addresses (`100.64.0.0/10`) as a private network: a public page calling one triggers the browser's local network access permission prompt once per site (until it is allowed the workspace shows as offline), and the server must answer the preflight with `Access-Control-Allow-Private-Network: true`, which it does when cloud access is on.
- **(b) Tailscale Funnel on the server's web port.** Gives the server a public HTTPS address, so any device works. The operator must turn it on, and the server is then exposed to the internet behind its own sign-in.
- **(c) A Superbot relay.** The server keeps an outbound connection to a relay we host and the page talks to the relay. Needs no inbound access at all. Not built; hosted workspaces need it anyway.

### Hosting on Vercel

`apps/web/vercel.json` builds the cloud app from the monorepo and rewrites every path without a file to `index.html`. The project's root directory is `apps/web`. Environment: `VITE_SUPERBOT_CLOUD=1` and `VITE_CLERK_PUBLISHABLE_KEY`.

### Later

Hosted plans (`kind: "hosted"`, Clerk Billing), the relay, a server-side workspace directory, a content security policy for the hosted origin, and a production Clerk instance with its own Google OAuth credentials.
