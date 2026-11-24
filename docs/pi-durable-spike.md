# Pi Durable spike (phase 1)

Superbot runs agents on `@earendil-works/pi-agent-core`'s in-memory `Agent`
(`PiAgentRuntime`), and survives a process kill only through its own `TurnCheckpoint`
and the executor's lease and handover. This spike asks whether
`@earendil-works/pi-durable` 1.6.0 can carry a run across a kill instead, before any
production code changes. Nothing in the product uses it yet: the package is a dev
dependency of `@rakazo/testkit`, and the spike lives in
`packages/testkit/src/runtime/pi-durable/` as offline tests against the model emulator
(`pnpm exec vitest run packages/testkit/src/runtime/pi-durable`).

## What the tests prove

| Scenario                                                             | Storage             | Result                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash mid-tool, new Harness in the same process                      | memory              | Resumes; the replay-safe call runs again, the finished one does not                                                                                                                                                                     |
| `kill` (SIGKILL / TerminateProcess) while a side-effecting tool runs | SQLite, new process | The tool is **not** run again; the model gets an error result `Tool charge_card was interrupted and may have partially run`, and the run goes on                                                                                        |
| Same, with a host `afterTool` hook                                   | SQLite, new process | The hook sees diagnostic code `interrupted` and replaces the text; Durable still appends its diagnostic                                                                                                                                 |
| Kill while a replay-safe tool runs                                   | SQLite, new process | The tool runs again and the run finishes                                                                                                                                                                                                |
| Kill while the answer streams                                        | SQLite, new process | The request is sent again with the same context; the partial answer is not in it                                                                                                                                                        |
| Graceful `close()` mid-tool (drain, deploy)                          | memory              | Same as a crash for a side-effecting tool: aborted, never resumed, reported as interrupted                                                                                                                                              |
| Model change between turns and mid-run (`configure`)                 | memory              | Next request goes to the new model, with the other model's tool calls in context; the choice survives a reopen                                                                                                                          |
| Superbot's `resolveRuntimeModel` output                              | memory              | Runs; a per-run model change (`withOutputBudget`) reaches the request only through a pinned `getModel`                                                                                                                                  |
| Two processes open one SQLite file                                   | SQLite              | **No cross-process lock.** The second recovers the first's live call as crashed and runs it again beside it; the first then fails its Session with `storage_failed: ID … already belongs to entry` and exits. The file stays consistent |
| A file written by a newer Durable                                    | SQLite              | Refused: `SQLite schema version 3 is newer than supported version 2`                                                                                                                                                                    |

The same request ID finds the same submission after a restart, so the child process
that starts a run is also the one that resumes it.

## The plan's assumptions, checked against the installed package

| Assumed                                    | In 1.6.0                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Harness.open({ models })`                 | `Harness.open(storage, { models, registry, settings?, env?, onReport?, readOnly? }, context)`. `models` is a pi-ai `Models` or a function returning one, shared by every conversation of that Harness |
| `defineTool` with a replay policy          | Yes: `replay: "safe" \| "unsafe"`, default `unsafe`                                                                                                                                                   |
| Per-conversation `configure`               | Yes: `conversation.configure({ model: { provider, modelId }, thinkingLevel, tools, modelTools, instructions, cwd, maxTurns, compaction }, context)`                                                   |
| `agent.model` / a `pi.agent` document      | Yes: stored in the `pi.agent` document; `conversation.agent(context).model` returns `{ provider, modelId }`, not a pi-ai `Model`                                                                      |
| `openNodeSqliteStorage` over `node:sqlite` | Yes, from `@earendil-works/pi-durable/storage/sqlite/node`; WAL, `BEGIN IMMEDIATE`, 5 s busy timeout                                                                                                  |
| Every async call                           | Takes a Chord `Context` (`BACKGROUND_CONTEXT` from `@earendil-works/chord/context`); tool cancellation is `context.abortSignal`                                                                       |
| Resume                                     | Not automatic: `harness.resume()`, or any submit or wait, starts the scheduler                                                                                                                        |
| A Durable `Agent` replaces pi-agent-core   | Durable does not use pi-agent-core at all; it calls `models.getModel()` and `models.streamSimple()` from pi-ai directly                                                                               |

## Cross-platform

- `node:sqlite`: available on the server's Node 24 and inside Electron 45.2.3, whose
  Node is 24.22.2 (checked here with `ELECTRON_RUN_AS_NODE=1`; SQLite 3.53.4). The
  spike's child processes also ran on that Electron binary on this Linux host
  (`DURABLE_SPIKE_NODE=<electron>`), all tests passing. The platform workflow probes
  Electron's `node:sqlite` on Windows and macOS.
- Abrupt kill: `child.kill("SIGKILL")` is SIGKILL on Linux and macOS and
  `TerminateProcess` on Windows. The spike uses only that.
- Files: SQLite leaves `-wal` and `-shm` beside the database after a kill; the next
  open recovers them. Removing the folder after a killed child retries, since Windows
  can hold the handles for a moment. Paths come from `path.join` and `os.tmpdir()`.
- Where storage would live: the server's `DATA_DIR`; the desktop stack's
  `<userData>/<stack>/data`, shared by its API and worker processes.

## Storage under the single-writer constraint

Durable keeps the open Session's state in memory and assumes one writer per storage.
Superbot has several API and worker processes, in containers without a shared disk,
handing runs to each other through `withLease`. The desktop stack runs its API and its
worker as two processes on one disk.

Recommendation: **a Postgres-backed Durable `Storage`, opened only under the run's
lease.** Postgres is already in every deployment, including the desktop stack.

- One Harness per conversation (or per bot), opened by the process that holds the
  lease for it and closed when the lease ends (drain, handover, idle). The lease gives
  the single writer Durable needs.
- Every commit checks the lease's fence in the same transaction, so a process that
  lost its lease fails its commits instead of writing over the new owner, which is the
  failure the two-writer test shows, made deliberate.
- The custom backend must pass `registerStorageConformance` from
  `@earendil-works/pi-durable/testing` (about 17 methods: `commit`, `mintId`, the
  `scan*` reads, documents, `close`).

A SQLite file per bot or run under `DATA_DIR` works only on one machine: a run handed
to a worker in another container cannot reach it, and the desktop's two processes
would still need the lock the two-writer test shows is missing.

## How Superbot features would map

| Superbot                                 | Durable                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approvals                                | A `beforeTool` gate that sleeps on a signal keyed by the arguments; the approval card answers with `harness.signal()`. Holds no process while waiting                                                              |
| `ask_user`, takeover                     | A tool that parks (`{ sleep: { signals, until } }`) and runs again with the answer                                                                                                                                 |
| Subagents                                | A task-owned conversation driven from a tool, parked on `SubmissionSettled`                                                                                                                                        |
| Computer, shell, browser, mail, payments | `replay: "unsafe"` (the default). An interrupted call reaches an `afterTool` hook with code `interrupted`, where Superbot decides: report it, ask the person, or check its own effect ledger (`effectOccurrences`) |
| Steer                                    | `submit({ whenBusy: "steer" })`; follow-ups queue in `pi.inbox`                                                                                                                                                    |
| Stop                                     | `conversation.abort()`                                                                                                                                                                                             |
| Drain, deploy                            | Close the Harness when the lease is handed back; the next owner reopens and calls `resume()`. A model request a close stopped is sent again; a side-effecting tool is not                                          |
| Fallback models                          | Stay Superbot's (`selectConfiguredModel`). A failed run ends with `runFailure: model_error`; the runtime configures the next model and submits `{ type: "continue" }`                                              |

## Versioning risk

The SQLite schema is versioned (`durable_schema`, version 2 in 1.6.0) and a newer file
is refused, so rolling back a release after Durable migrated its storage breaks every
open run. Task definitions carry versions too: a task stored by a newer
`pi.generation` or `pi.tool` is blocked as `task_too_old`. The package is marked
experimental and its API changes without notice. Pin exact versions, upgrade Durable
only in a release that cannot be rolled back past it, and test reopening a store from
the previous version before each upgrade.

## The model seam

`resolveRunModel` (`packages/adapters/src/runs/turn/run-model.ts`) picks the model and
fallbacks; `runModelTurn` hands it to the runtime as `request.model`
(`run-model-turn.ts`, `deps.runtime.run(...)`). A `PiDurableRuntime` implementing
`AgentRuntime` takes it there, unchanged, and:

1. calls `resolveRuntimeModel(request.model)` (`pi-runtime-models.ts`) for
   `{ provider, modelId, models, model }`;
2. gives the Harness `models: () => pinned`, where `pinned.getModel(provider, modelId)`
   returns that resolved `model`, so connection limits and per-run changes
   (`withOutputBudget`, `resizeRuntimeTarget`, data retention, routing) reach the
   request: a lookup by id alone returns the registry's copy without them;
3. calls `conversation.configure({ model: { provider, modelId } })` before it submits.

Because `models` belongs to the Harness, not the conversation, each Harness serves one
bot's credentials; that matches one Harness per leased conversation.

## Phase 2 steps

1. A Postgres `Storage` passing Durable's conformance suite, behind a fence column on
   the existing run lease; a migration adds only tables.
2. `PiDurableRuntime` in `packages/adapters/src/runtime/pi/`, loaded with a dynamic
   `import()` only when configured, implementing `AgentRuntime` with the model seam
   above and emitting the same `AgentRuntimeEvent`s from conversation watches.
3. Superbot's tools redefined with `defineTool` and an explicit `replay` each: reads
   safe; computer, shell, browser, mail, payments and anything else with an effect
   unsafe, with an `afterTool` policy for `interrupted`.
4. Approvals, `ask_user`, takeover and subagents as gates and parks on signals.
5. Behind a setting, run both runtimes over the same offline scenarios; then replace
   `Agent` and `TurnCheckpoint` and drop `RUN_DRAIN_MS` turn draining.
