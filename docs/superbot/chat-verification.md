# Offline CLI chat verification

Run from the repository root on Windows with the workspace dependencies installed, the Prisma client generated, and the API migration command built. Supply a local PostgreSQL binary directory containing `initdb.exe` and `pg_ctl.exe`, and the installed Superbot executable.

```powershell
pnpm db:generate
pnpm --filter @rakazo/api build
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" "$env:USERPROFILE/.cargo/bin/superbot.exe"
```

The verifier starts a fresh PostgreSQL cluster, migrates it with a dedicated owner role, and starts the Superbot API and worker with a separate runtime login. It uses dynamically allocated loopback ports, a temporary data directory, a fake sandbox, and disposable password accounts. The model is the workspace's deterministic loopback streaming emulator. The fixture supplies its own environment and uses no hosted model credentials.

For a desktop comparison, pass the compiled `target/debug/superbot-desktop.exe` as a third argument after the CLI executable. The verifier opens the native client against the same disposable server after the chat assertions pass. Select the shared Space to inspect the conversation. Close the fixture desktop window to sign out and remove the temporary cluster. This keeps screenshots and writes separate from your personal workspace.

The harness creates the CLI session through Superbot's password sign-in endpoint. It pipes the signed fixture session to Windows Credential Manager under the new loopback origin. The helper refuses to replace an existing entry. The CLI exercises its regular credential loading and logout. Teardown stops the fixture services and PostgreSQL and removes the fixture directory and credential.

## Assertions

- The installed CLI resolves the agent by name in the selected Space, sends the typed prompt, prints `Fixture agent > The fixture response is blue.`, and exits successfully with empty stderr.
- The observer signs in separately, joins the Space by invitation, and opens the group thread stream before the owner sends a message. The stream carries the owner's user ID and display name in the human message payload and the responding agent's ID on the conversation event. The corresponding run completes.
- Concurrent retries of local notes and completed CLI exchanges return the same message IDs. A second signed-in member receives the local messages live and reloads them with the same author and origin. Unauthorized writes and attempts to supply a server run ID are rejected.
- Both prompts arrive at the model emulator and consume its two scripted responses. The API starts the live runs immediately while the worker is up with PostgreSQL's durable queue.

- Two additional conversations for the same bot carry separate hosted context and replies, survive a subscriber reconnect, and paginate independently of the default chat. The invited member can open both conversations, while an outsider cannot list, create, read, send, or follow in the Space.
- With `--local-cli`, the synthetic local CLI runs in two additional conversations. A pending retry from one stays pending while the other continues, then commits only to its original conversation.

## Recorded run

Passed on November 20, 2026 with the installed Windows `superbot-cli 0.1.0` and PostgreSQL 18.7. The verifier exited with status 0 and printed the lines below. CLI logout returned `Signed out.` and the fixture directory was removed.

```text
PASS installed Superbot CLI sent a message and printed its deterministic agent reply
PASS local notes and CLI turns retry safely and reload with matching live attribution
PASS a second signed-in Space member streamed the human and agent messages with matching author IDs
```

## Granted record apps with a local CLI model

Open `superbot <agent>` with a prompt-only local model selected for your agent.
Use `/apps` to list its granted record apps. `/app 1` shows recent records from
the first app. An optional `--date YYYY-MM-DD` filters the preview on the app's
first date field. Append a request to ask the selected model for help using
that preview. If the model proposes a record, type `save` after reviewing its
fields or press Enter to skip. After an unconfirmed save, `/app retry` in the
same chat session reuses the approved operation. App interactions stay outside
the conversation transcript.

```powershell
cargo build --locked -p superbot-cli
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" target/debug/superbot.exe --local-app-records
```

The isolated fixture uses a fake local CLI and two accounts in one Space. It
checks real record context, skipping and approving a draft, revocation while
approval is pending, stale pins after re-grant or version switch, and identical
operation replay. It also checks that the other account's records and the chat
transcript stay separate from the app interaction.

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

### Shared roster import

Add `--roster` to the Windows fixture command above to exercise `superbot import-bots`.
The fixture seeds one active bot and one archived bot, runs a dry run, then starts two
imports concurrently and repeats the import. It reads the Space from a second account
to verify that exactly one new bot appeared and that the archived bot stayed archived.
This check passed against disposable PostgreSQL on Windows.

### Native question cards

Two synthetic accounts exercised typed, multiple-choice and masked inputs on Windows.
A first-run focus card dismissed by the other account disappeared from an open native
conversation. Two simultaneous answers from the initiating account produced one
accepted answer and one HTTP 409. The client displayed the accepted answer without a
reload. The same fixture rejected an answer from the other member.

### Shared Board in the Windows desktop

Open **Manage workspace → Board** as a member with Board enabled. In the two-account
fixture, one member edited a description while the other changed the title, status and
priority and posted a comment. The desktop kept the draft, showed the other member's
changes, then saved the description and a second comment. Both were read back through
the other account. Creating a high-priority ticket in the desktop also gave the other
member the same ticket and assignee.

Switch from Board to chat, change a ticket from the other account, then reopen the
workspace. A loopback proxy recorded the Board stream closing on exit and opening
again on return, and the client displayed the change made while the board was closed.

### Typography and composer on Windows

Capture the same fixture conversation at a client size of 1280 × 820 and 100% display scale in Midnight and Daylight. Open sidebar search to take focus away from the composer. Move the pointer over the composer, then click in it and move the pointer back to the transcript. The border brightens for hover and stays bright for keyboard input. Typing a draft hides the hint. Clearing it restores the hint, and the editable field keeps its accessible name in both states.

In the Windows release, the empty hint matched the reference at its strongest pixels in both themes (green channel 108 in Midnight and 173 in Daylight). The top edge of the composer had the same position and its rest colour differed by one level. To check the code font separately, display the same fenced Markdown reply in two fixture clients with the same sans face, one with a private mono face and one using the bundled mono face. The glyphs in the rendered reply changed when only the mono face changed.

## Web links to bot conversations

Open an additional bot conversation at `/app/<botId>?threadId=<threadId>`.
The native workspace handoff uses this link when an additional conversation
is selected. The web app asks the member to sign in if necessary and resolves
the selected thread in the bot's Space. An unavailable conversation shows an
error and has no composer. Direct bot chat uses `/app/<botId>` and group chat
uses `/app/g/<groupId>`.
