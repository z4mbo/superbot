# Sign-in source

A sign-in source is a password manager the person connects once. When a bot needs to sign in to a
website, it calls `sign_in` with the site's address. The chat shows a card, and the person reviews
the request in the password manager's own app. Once they approve it, the password manager's browser
extension fills and submits the login in the bot's browser. Superbot never receives the username,
password or one-time code. They are not in the server, the transcript, tool results or the model's
context. The bot only learns whether the login was filled.

## Status

| Provider  | `SIGN_IN_SOURCE_PROVIDER` | State                                                                          |
| --------- | ------------------------- | ------------------------------------------------------------------------------ |
| Emulator  | `emulator`                | Works offline. Used by tests and the e2e server.                               |
| 1Password | `onepassword`             | Adapter written and tested against stubs. Live fill waits on partner approval. |
| (none)    | `none` or unset           | Default. The `sign_in` tool and the Connect entry are hidden.                  |

**Live fill does not work yet.** 1Password for Agents is a partner preview. A deployment needs an
OAuth client that 1Password registers for it, and Superbot is not a registered partner. It has no
integration key, client id or client secret, and none is included here. Until 1Password approves a
registration, a deployment set to `onepassword` lists the Connect entry as "Not available yet".

The bot computer's Chrome also carries no password manager extension today. The fill runs only in
the in-process browser that tests use, so on a real computer `sign_in` answers that this computer's
browser can't fill logins yet. It says so before anyone is asked to approve anything.

## What a deployment supplies to turn on the live provider

1. A partner registration with 1Password, which gives the deployment an OAuth client:
   - `SIGN_IN_SOURCE_CLIENT_ID`
   - `SIGN_IN_SOURCE_CLIENT_SECRET`
2. `SIGN_IN_SOURCE_PROVIDER=onepassword`.
3. The redirect address registered with that client: `<WEB_ORIGIN>/sign-in-source/callback`.
4. A bot computer image whose Chrome has the 1Password extension, and a page browser that passes
   the provider's fill call to that extension (`BrowserProvider.signInFill`). Neither exists yet.

The integration key is not a setting. 1Password returns it to the redirect page the first time a
person connects, and the server seals it with that person's tokens.

## What the live provider uses

- Connect is OAuth 2.0 with PKCE. Tokens and the integration key are sealed in `secrets` (kind
  `sign_in_source`). The `sign_in_sources` row only names them.
- Access requests use the credential broker in `@1password/sdk`, pinned to
  `0.0.0-credential-broker-dev-preview.4`. It is loaded with a dynamic `import()` only when the
  provider is configured. The adapter uses `accessRequests.create` and `getStatus` only. It never
  calls `logins.read`, which returns the login's values.
- Only the person's approval in the 1Password app grants a login. Nothing the bot sends can. An
  approval lasts 30 days for that site, and the person is asked again once 1Password says it is gone.
- The server checks the request's status only after the person opens the review, on the schedule
  1Password asks for, and stops after three minutes. The card follows the request through the
  thread's own update signals, so clients never poll.

There is no service account, Connect server or anything else that would hand passwords to the
server or the model.

Vendor references: <https://support.1password.com/1password-for-agents/>,
<https://www.1password.dev/agentic-autofill/partners/sdk>.

## Code

- Interface: `packages/adapter-kit/src/sign-in-sources.ts`
- Emulator, connections, requests, tool: `packages/adapters/src/sign-in-sources/`
- 1Password adapter: `packages/adapters/src/providers/sign-in-source/onepassword/`
- Run tool: `packages/adapters/src/runs/tools/run-tools-sign-in.ts`
