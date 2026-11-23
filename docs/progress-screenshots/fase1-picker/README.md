# Model picker, phase 1: screenshots and evidence

Phase 1 locks today's model picker behavior before the agent runtime is replaced. It adds tests
only; no product UI, copy or behavior changed. Every screen and value shown here is fixture data
(`rakazo-e2e-*` models on a loopback address that nothing listens on, a generated test account).

## Files

### web/ (captured locally on Linux by `apps/web/e2e/chat/bot-model-pick.spec.ts`)

| File | What it shows |
| --- | --- |
| `01-settings-models.png` | Settings → Models: the main model is the first connected model. |
| `02-bot-model-before.png` | The chat with the model picker beside Send, showing the main model the bot follows. |
| `03-composer-model-picker-open.png` | The picker open in chat: Space default (checked) and both connected models. |
| `04-bot-model-after.png` | After picking the second model and the High thinking level for the bot. |
| `05-bot-settings-model.png` | After a reload, the bot's Settings show the same model and thinking level. |

The spec then sends a message and checks that the run starts on the picked model (read from
`threads/get` while the scripted run waits on a question).

### test-evidence/

| File | What it shows |
| --- | --- |
| `linux-test-results.png` | The new unit tests (25), the Postgres integration test and the web e2e spec, all passing on this Linux host. |
| `ci-unit-tests-three-os.png` | Both new unit files passing on ubuntu, windows and macos in the cross-platform workflow ([run 45184455851](https://github.com/z4mbo/superbot/actions/runs/45184455851)). |

## What ran where

- **Locally on this Linux host:** the two new unit files, the Postgres integration test
  (`pnpm test:integration -- --spec=bot-model-pick`) and the web e2e spec
  (`pnpm test:e2e -- --spec=bot-model-pick`, scripted runtime, Chromium). All passed.
- **In CI on ubuntu, windows and macos:** the two new unit files are added to the
  cross-platform workflow's unit list (`.github/workflows/cross-platform.yml`). They passed on
  all three in [run 45184455851](https://github.com/z4mbo/superbot/actions/runs/45184455851)
  (job "Unit tests"). That run's other failures are not from this branch: the temporary
  "Whole unit suite on Windows" inventory jobs are expected to fail, and "Desktop
  (macos-latest)" was cancelled before it ran a step.

## Gaps

- **Desktop (Linux, Windows, macOS): the model picker was not captured inside the Electron app.**
  The desktop Playwright fixtures load a static page or a fake container runtime. None of them
  starts the API, a database and the web app, so the chat and its picker cannot be reached there,
  and building a fake service for that is out of scope. The desktop window loads the same web
  shell shown under `web/`. Electron also cannot start on this NixOS host (missing system
  libraries), so Linux desktop could not be checked locally either.
- **macOS and Windows:** this host cannot run either. They are covered only by the CI run of the
  unit tests.
- **Mobile (model-picker, bot-model and chat-model screens): not captured.** The mobile
  screenshot runner needs an Android emulator, and its backend port is fixed to one already used
  on this host by another service.
- **OAuth on the wire:** the runtime conformance test uses the offline chat-completions endpoint,
  which has no sign-in flow. Subscription sign-ins are covered at the resolution layer (the run
  hands the runtime OAuth, never an API key) but not as a request to a provider.
