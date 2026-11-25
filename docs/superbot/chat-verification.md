# Offline CLI chat verification

Run from the repository root on Windows with the workspace dependencies installed, the Prisma client generated, the API migration command built and the `superbot` command built from this checkout. Supply a local PostgreSQL binary directory containing `initdb.exe` and `pg_ctl.exe`.

```powershell
pnpm db:generate
pnpm --filter @rakazo/api build
pnpm --filter superbot-cli build
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin"
```

The verifier starts a fresh PostgreSQL cluster, migrates it with a dedicated owner role, and starts the Superbot API and worker with a separate runtime login. It uses dynamically allocated loopback ports, a temporary data directory, a fake sandbox, and disposable password accounts. The model is the workspace's deterministic loopback streaming emulator. The fixture supplies its own environment and uses no hosted model credentials.

The harness creates the CLI session through Superbot's password sign-in endpoint. It pipes the signed fixture session to Windows Credential Manager under the new loopback origin. The helper refuses to replace an existing entry. The CLI exercises its regular credential loading and logout. Teardown stops the fixture services and PostgreSQL and removes the fixture directory and credential.

## Assertions

- The CLI resolves the agent by name in the selected Space, sends the typed prompt, prints `Fixture agent > The fixture response is blue.`, and exits successfully with empty stderr.
- The observer signs in separately, joins the Space by invitation, and opens the group thread stream before the owner sends a message. The stream carries the owner's user ID and display name in the human message payload and the responding agent's ID on the conversation event. The corresponding run completes.
- Concurrent retries of local notes and completed CLI exchanges return the same message IDs. A second signed-in member receives the local messages live and reloads them with the same author and origin. Unauthorized writes and attempts to supply a server run ID are rejected.
- Both prompts arrive at the model emulator and consume its two scripted responses. The API starts the live runs immediately while the worker is up with PostgreSQL's durable queue.

- Two additional conversations for the same bot carry separate hosted context and replies, survive a subscriber reconnect, and paginate independently of the default chat. The invited member can open both conversations, while an outsider cannot list, create, read, send, or follow in the Space.

## Marketplace skill through the CLI

Pass `--issue-watcher` to the same fixture to create the Store's GitHub bot, grant it a loopback MCP issue list and drive its actual routine. The fixture takes a baseline, adds issue #42, checks for one chat alert on a second account, revokes access and asks the watcher to send the issue to a development agent. It checks the task in the recipient's thread and the reply in the watcher's thread. [Setup and harness](agent-harness.md)

Run the same fresh Windows fixture with the marketplace check enabled.

```powershell
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" --marketplace
```

The second account submits a declarative skill. Its review attempt is refused.
The verified reviewer approves the version, installs it in the fixture Space,
and grants its skill part to the fixture agent. A separate CLI turn prompts
the loopback emulator to call the tool the worker offers for that grant. The
fixture checks the worker's tool result for the exact published instructions
before returning the final reply the CLI must print. The skill has no remote
endpoint. The API, worker, PostgreSQL, and emulator use a temporary fixture
with local connections.

### Shared roster import

Add `--roster` to the Windows fixture command above to exercise `superbot import-bots`.
The fixture seeds one active bot and one archived bot, runs a dry run, then starts two
imports concurrently and repeats the import. It reads the Space from a second account
to verify that exactly one new bot appeared and that the archived bot stayed archived.

## Web links to bot conversations

Open an additional bot conversation at `/app/<botId>?threadId=<threadId>`.
The web app asks the member to sign in if necessary and resolves
the selected thread in the bot's Space. An unavailable conversation shows an
error and has no composer. Direct bot chat uses `/app/<botId>` and group chat
uses `/app/g/<groupId>`.
