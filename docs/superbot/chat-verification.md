# Offline CLI chat verification

Run from the repository root on Windows with the workspace dependencies installed, the Prisma client generated, and the API migration command built. Supply a local PostgreSQL binary directory containing `initdb.exe` and `pg_ctl.exe`, and the installed Superbot executable.

```powershell
pnpm db:generate
pnpm --filter @rakazo/api build
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" "$env:USERPROFILE/.cargo/bin/superbot.exe"
```

The verifier starts a fresh PostgreSQL cluster, migrates it with a dedicated owner role, and starts the Rakazo API and worker with a separate runtime login. It uses dynamically allocated loopback ports, a temporary data directory, a fake sandbox, and two disposable password accounts. The model is the workspace's deterministic loopback streaming emulator. The fixture supplies its own environment and uses no hosted model credentials.

For a desktop comparison, pass the compiled `target/debug/superbot-desktop.exe` as a third argument after the CLI executable. The verifier opens the native client against the same disposable server after the chat assertions pass. Select the shared Space to inspect the conversation. Close the fixture desktop window to sign out and remove the temporary cluster. This keeps screenshots and writes separate from your personal workspace.

The harness creates the CLI session through Rakazo's password sign-in endpoint. It pipes the signed fixture session to Windows Credential Manager under the new loopback origin. The helper refuses to replace an existing entry. The CLI exercises its regular credential loading and logout. Teardown stops the fixture services and PostgreSQL and removes the fixture directory and credential.

## Assertions

- The installed CLI resolves the agent by name in the selected Space, sends the typed prompt, prints `Fixture agent > The fixture response is blue.`, and exits successfully with empty stderr.
- The observer signs in separately, joins the Space by invitation, and opens the group thread stream before the owner sends a message. The stream carries the owner's user ID and display name in the human message payload and the responding agent's ID on the conversation event. The corresponding run completes.
- Both prompts arrive at the model emulator and consume its two scripted responses. The API starts the live runs immediately while the worker is up with PostgreSQL's durable queue.

## Recorded run

Passed on November 19, 2026 with the installed Windows `superbot-cli 0.1.0` and PostgreSQL 18.7. The verifier exited with status 0 and printed both lines below. CLI logout returned `Signed out.` and the fixture directory was removed.

```text
PASS installed Superbot CLI sent a message and printed its deterministic agent reply
PASS a second signed-in Space member streamed the human and agent messages with matching author IDs
```

## Native sidebar notifications

Add the Rust probe to verify the signed sidebar stream with the same two disposable accounts.

```powershell
cargo build --locked -p superbot-client --example fixture_space_notifications
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" "$env:USERPROFILE/.cargo/bin/superbot.exe" --notifications-probe target/debug/examples/fixture_space_notifications.exe
```

The observer opens `notifications.subscribe` before the owner creates an agent. It re-reads the scoped Space after change signals and verifies both creation and renaming for an agent and a group, then finds the group preview after the owner sends a message to it. The probe uses the same signed Rust client as the desktop and leaves the observer's group thread unopened during the notification checks.

## Marketplace skill through the CLI

Run the same fresh Windows fixture with the marketplace check enabled. Build
the CLI from this checkout so the fixture runs the current binary.

```powershell
cargo build --locked -p superbot-cli
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" target/debug/superbot.exe --marketplace
```

The second account submits a declarative skill. Its review attempt is refused.
The verified reviewer approves the version, installs it in the fixture Space,
and grants its skill part to the fixture agent. A separate CLI turn prompts
the loopback emulator to call the tool the worker offers for that grant. The
fixture checks the worker's tool result for the exact published instructions
before returning the final reply the CLI must print. The skill has no remote
endpoint. The API, worker, PostgreSQL, and emulator use a temporary fixture
with local connections.

Passed on November 19, 2026 with the checkout-built Windows CLI and
PostgreSQL 18.7. The CLI printed the final reply, and the verifier exited with
status 0 after signing out and stopping the disposable services.

```text
PASS a published and granted marketplace skill returned its instructions to the model through the CLI chat
```
