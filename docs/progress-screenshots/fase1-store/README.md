# Phase 1: app store for UI apps

Screenshots for the app store work (publish, review, browse, install with consent, open in the
sandbox). Fixture data only.

## web/

Captured locally on the Linux host by `apps/web/e2e/settings/app-store.spec.ts`, run through the
e2e harness (`pnpm test:e2e -- --spec=app-store.spec.ts`) in headless Chrome at 1280×720.

| File | What it shows |
| --- | --- |
| `integrations-baseline.png` | Integrations before any app is approved: the marketplace as it is today (featured connectors, plugin sections, more apps). With no reviewed app the store adds nothing to this screen. |
| `app-store-browse.png` | Browse with one reviewed app: the **Apps** section after the featured connectors and before the plugin sections, with the app's **Add** button. |
| `app-store-detail.png` | The app's page: icon, name, **Add**, its description and the **Permissions** it asks for. |
| `app-store-permission-prompt.png` | The consent step: **Allow Focus timer to:** with each permission, **Cancel** and **Allow**. Nothing is installed until **Allow**. |
| `app-store-installed.png` | The same page once added: **Remove** and **Open**, and the permissions that were granted. |
| `app-store-opened.png` | The installed app running in the page viewer's sandbox inside the Integrations dialog. |

In the spec the real server checks and stores the submitted app (`apps/submit`). Approval needs a
deployment admin, which the shared e2e harness does not configure, so from the listing on the
spec answers the store's own reads and writes (`apps/catalog`, `apps/installed`, `apps/install`,
`apps/launch`) as an approved app would, and checks the exact install request the consent sends.
The real review, install, launch and refusal paths are covered against PostgreSQL by
`apps/api/src/app-store/app-store.postgres.test.ts`.

## linux-desktop/, windows-desktop/, macos-desktop/

Taken in CI by the cross-platform workflow (`.github/workflows/cross-platform.yml`), with
`apps/desktop/e2e/app-sandbox.spec.ts`: the Electron window hosts an installed app's compiled
code in the same sandbox the web app uses (scripts only, no same-origin access, a policy that loads
nothing from the network). The spec clicks the app's button, checks that the app cannot read the
host window or fetch from the network, and saves `app-sandbox.png`.

The run and its artifacts are linked from the pull request; the PNGs are copied here once it
finishes.

## Gaps

- **Windows and macOS desktop: not run on this host.** It is a headless NixOS server; those
  platforms are covered only by the CI run above. The owner's Mac was not reachable.
- **Desktop screenshots show the sandboxed app, not the Integrations dialog.** The desktop e2e
  suite runs against fixture servers, not the full web app and API, so the dialog itself is shown
  on the web only. The desktop window hosts the same web UI.
- **App launched from chat: not in this phase.** A bot can find installed apps (`find_apps`); opening
  one in the chat needs an app card and the app SDK's host wiring, planned for phase 2.
- **Mobile: not captured.** The mobile app does not list apps yet; nothing on mobile changes.
