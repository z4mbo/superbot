# T3 Code inbox in the desktop app

Bots propose coding work in the bundled **T3 Code inbox**. You review each
request in the Superbot desktop app and start the ones you approve in your own
T3 Code. You don't need a terminal for this.

The view opens only for the inbox that ships with Superbot: the approved
version `superbot-t3-code-inbox-v1` with slug `t3-code-inbox`. A marketplace
plugin with the same name or slug opens as an ordinary app and can't reach T3.

## Set up the inbox

1. In **Store → Plugins → Discover**, install **T3 Code inbox** in the Space where bots
   should propose work.
2. On its page, grant **Requests** and **Request guide** to each bot that
   proposes requests. Keep **Dispatches** ungranted, so only you write
   receipts. When a bot adds a request, you approve the normal write card.

## Connect T3 and start a request

1. Open **Store → Plugins → Installed → T3 Code inbox**.
2. Paste the MCP URL from T3's **Use T3 Code in another app (MCP)** settings
   and choose **Connect T3**. It must be an `https://` address ending in
   `/mcp`, or `http://127.0.0.1:PORT/mcp` on this computer. In the T3 page
   that opens, check that the client is **Superbot T3 Code inbox** and the
   callback is on `127.0.0.1`. Choose **Supervised** and approve.
3. Under **Start in**, choose the T3 project.
4. Open a request to read its full brief. Choose **Start in T3**, check the
   project in the confirmation, then choose **Start**.
5. The request then shows **Started** with T3's status at launch. Use
   **Open in T3** to follow the thread and handle its approvals in T3.

T3 runs the thread in Supervised mode with the project's workspace settings.
It uses the project's default model. When the project has none, the app asks
T3 for its providers and uses the first model of the first one that can run,
as Superbot's hosted T3 Code agents do. That provider runs with the account it
is signed in to on the T3 computer. The app sends only the request's title and
brief.

## Retries and receipts

Each start uses one T3 request ID, which is saved before the app calls T3.
If T3's reply is lost, start the request again with the same connection and
project. T3 returns the original thread, and the app saves that receipt.
A start with a different project or a changed brief is refused, so is a retry
over another T3 connection. Check those in T3. If T3 started the thread but the
receipt couldn't be saved, choose **Save receipt**. The app retries with the
receipt T3 already returned and doesn't call T3 again.

Plans and receipts are stored in `t3-code-inbox` in the Superbot settings
folder: `%LOCALAPPDATA%\Superbot` on Windows,
`~/Library/Application Support/Superbot` on macOS, or `SUPERBOT_CONFIG_DIR`
when set. They contain no token. The T3 token is kept in the system credential
store for this Superbot server and account. **Disconnect** removes it from
this computer and keeps the plans and receipts. To revoke the grant itself,
use T3's **Settings → Sharing & access**.

The T3 connection runs inside the desktop app, so the installed app needs no
extra files. Superbot's hosted bots reach T3 through a T3 Code server
connection instead, as described in
[Connect T3 Code](../self-host-integrations.md#connect-t3-code).

## When something fails

Every error says what to check:

- **Couldn't reach T3**: T3 isn't running, or the URL is wrong.
- **This address didn't ask for a T3 sign-in**: the URL isn't T3's MCP
  endpoint, or T3 needs an update.
- **T3 no longer accepts this connection**: the grant expired or was revoked.
  Disconnect, then connect again.
- **T3 refused t3_thread_launch (code): T3's reason**: T3 rejected the
  launch, for example because the project is gone. The reason is T3's own
  first line. Check T3.
- **No provider in T3 can run**: the project has no default model and every
  provider is signed out or disabled. Sign in to one or set a default model
  in T3.
- **T3 didn't answer**: start the request again. It reuses the same T3 request
  ID, so T3 can't start it twice.

## Verification

The bridge probe signs in to a loopback T3 that serves T3's OAuth and the
shared T3 MCP emulator. It then exercises lost replies, receipt replay,
conflicting retries, concurrent starts, a changed grant, a revoked grant and a
missing project. It also covers a project with no default model, a T3 with no
runnable provider, and a sign-in answer naming another issuer. It also checks
that no token reaches the ledger or the output.

```powershell
cargo build --locked -p superbot-t3-inbox --example t3_inbox_probe
node --import tsx infra/superbot/verify-t3-inbox.mjs target/debug/examples/t3_inbox_probe.exe
```

The desktop run uses the [isolated chat fixture](chat-verification.md). A
granted fixture bot proposes a request through the worker's app tool. The
fixture prints a loopback T3 MCP URL, opens the desktop app, and waits for you
to connect it and start a request. After you close the window, it checks that
T3 started one thread with the exact supervised arguments, that the inbox has
one matching receipt, that replaying the receipt returns the saved record, and
that a conflicting receipt is refused.

```powershell
cargo build --locked -p superbot-cli -p superbot-desktop
node --import tsx infra/superbot/verify-chat.mjs "C:/path/to/postgresql/bin" target/debug/superbot.exe target/debug/superbot-desktop.exe --t3-inbox
```

### Against a real T3 Code server

`verify-t3-inbox-real.mjs` drives the same probe against a running, disposable
T3 Code server. The owner signs in with the one-time `/pair#token=` link the
server printed. The script then approves Supervised access on T3's consent API,
as the owner choosing **Approve** on T3's page would. It checks discovery,
registration, the approval page's client name and callback, the issuer and PKCE
exchange, and `t3_project_list`. It never prints a code, state or token.

It stops before `t3_thread_launch` unless you pass `--launch`. A launch starts
a turn on a provider the server can run. A provider CLI can use this
computer's signed-in account even when the server has its own profile
directories, so pass `--launch` only for a server whose providers are signed
out or fake.

```powershell
t3 --base-dir C:path	odisposable --host 127.0.0.1 --port PORT --no-browser --auto-bootstrap-project-from-cwd C:path	odisposable-project > server.log
node infra/superbot/verify-t3-inbox-real.mjs target/debug/examples/t3_inbox_probe.exe http://127.0.0.1:PORT/mcp server.log disposable-project
```
