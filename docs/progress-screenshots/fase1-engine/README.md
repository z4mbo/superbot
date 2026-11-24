# Phase 1, engine: pi-durable kill/resume spike

Evidence for the spike in `packages/testkit/src/runtime/pi-durable/` (findings in
`docs/pi-durable-spike.md`). The spike is a test suite, not UI, so its evidence is the
test run rendered as an image. The web screenshots are a baseline of today's run and
approval UI, to compare against after the engine swap in a later phase. All data is
fixture data.

## web/ (local, this Linux host, e2e harness)

| File                                   | Shows                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-run-in-progress-approval-card.png` | A run in progress (sidebar "Working…", Stop in the composer) waiting on an approval card: Allow once, Always allow this tool, Deny. From `apps/web/e2e/approvals/consequential-approval.spec.ts`                                                                                                     |
| `02-approval-allowed-once.png`         | The same approval after Allow once. Same spec                                                                                                                                                                                                                                                        |
| `03-progress-fixture-streaming.png`    | The mid-turn progress fixture with a streaming reply. Captured by Playwright when `apps/web/e2e/chat/chat-progress-messages.spec.ts` failed: on this host it finds three `status` roles where it expects none, in two runs. This branch does not change web code; the failure is reported, not fixed |

## linux-desktop/ (local, this Linux host)

| File                               | Shows                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-spike-linux-node.png`          | The spike on the server's Node (24.22.2): 10 of 10 passed, child processes killed for real                                                                                                                          |
| `02-spike-linux-electron-node.png` | `node:sqlite` opened inside Electron 45.2.3 (Node 24.22.2, SQLite 3.53.4), then the spike with every child process running on that Electron binary as Node, as the desktop app's local server does: 10 of 10 passed |

The Electron binary is the one `apps/desktop` pins, run with `ELECTRON_RUN_AS_NODE=1`.
The desktop app window itself was not opened: the spike changes no desktop code.

## windows-desktop/ and macos-desktop/ (CI only)

The spike's test run in the cross-platform workflow's unit job on `windows-latest` and
`macos-latest`, rendered from the job logs. That job runs the server's Node, not the
Electron binary; the workflow's desktop job separately opens `node:sqlite` inside
Electron 45.2.3 on each OS (its "Runtime versions" step). This host cannot run Windows
or macOS, and the linked Mac was not used.
