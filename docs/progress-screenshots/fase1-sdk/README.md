# Phase 1: plugin SDK (apps)

Fixture data only. Every screenshot comes from a test run against a disposable database.

## web/ (taken locally on Linux, through the e2e harness)

`apps/web/e2e/pages/apps.spec.ts`, on Chrome against a local API and web server with the
harness's emulated model.

| File                         | Shows                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/app-person-actions.png` | The example team dashboard open where pages open, after the person added a task ("Write the release notes", owner Alex) with the app's form and pressed "Shipped one". Shipped shows 1.                                                             |
| `web/app-bot-action.png`     | The same open app after the bot ran `run_app_action` (setStatus → At risk) from the chat: the status pill changed to At risk without reloading the app, and the person's task is still there. The bot's chat reply sits behind the full-screen app. |
| `web/app-bot-refused.png`    | An app whose manifest grants only `state`: the bot's `run_app_action` is refused and the status stays On track.                                                                                                                                     |

## tests/

| File                           | Shows                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `tests/local-test-results.png` | Local results: unit suites, hostile bridge inputs, the web e2e spec, `pnpm checks` and typechecks. |

## linux-desktop/, windows-desktop/, macos-desktop/ (from CI)

`apps/desktop/e2e/app-sdk.spec.ts` opens the example app in the Electron window through the
real page viewer shell and the app runtime, then adds a task and sets the status with the app's own
controls. The window is served by a small fixture host standing in for the web app's page view (no
server or database), and actions run through the SDK's action engine, which the server also uses.
It runs in the `Cross-platform` workflow on ubuntu, windows and macos.

| File                               | Shows                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `<os>-desktop/app-sdk-opened.png`  | The example app as it opens in the desktop window.           |
| `<os>-desktop/app-sdk-actions.png` | After the person added a task and set the status to At risk. |

CI run: see "Cross-platform status" below.

## Gaps

- This NixOS host cannot run the Windows or macOS desktop app. Those platforms are covered only by
  the GitHub Actions workflow.
- The desktop screenshots use a fixture host, not the full desktop product with its bundled server.
  The product's page view in the desktop app is the same web code that the web e2e spec covers.
- Mobile: not captured. Mobile shows an app's stored state with its controls off, and no mobile
  screenshot flow covers app pages yet.
- The bot screenshot shows the result in the app, not the bot's tool card, because the open app
  covers the chat.
