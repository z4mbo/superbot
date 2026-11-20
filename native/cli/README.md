# Superbot terminal client

Superbot connects to an existing Superbot server. You need a Superbot account
that belongs to a Space with an agent. Agents can use a server model connection
or a supported CLI installed on this device.

Install from the repository root.

```shell
cargo install --path native/cli --locked
```

Create an account on a server with registration enabled using `superbot signup`. Follow the verification email when your server requires one.

Sign in to your local workspace at `http://127.0.0.1:5173` with your account password or an emailed
sign-in code. The terminal hides the password and code while you type.

```shell
superbot login
superbot login --code
```

Use `superbot server https://superbot.example.com` to save the default for the
desktop app and both commands on this device. `superbot server` prints the
effective origin. For a single invocation, `--server URL` takes precedence over
`SUPERBOT_SERVER` and the saved origin. The URL must be an HTTPS origin. A local
development server can use a loopback HTTP origin such as
`http://127.0.0.1:3000`.

The signed session is saved per server in Windows Credential Manager, macOS
Keychain, or the Linux Secret Service. On Linux an unlocked Secret Service is
required. Use `superbot logout` to revoke the session and remove it from that
store. If a session expires, run `superbot login` again. Deployments that
require browser-only federation must provide a native email sign-in method for
this client.

```shell
superbot
superbot "Research agent"
superbot --space "My space" "Research agent"
superbot list
```

The picker lists each agent with its space. Direct chat matches an exact name
first and accepts a case-insensitive match when unique. Use `superbot chat NAME`
to reach an agent whose name matches a command.

Start a separate conversation with the same agent using `--new-conversation`.
To reopen a particular conversation, use its thread ID from the web link's
`threadId` parameter.

```shell
superbot chat "Research agent" --new-conversation
superbot chat "Research agent" --conversation THREAD_ID
```

Members of the same Space can follow its replies on other devices. Each
conversation has its own history. The agent uses its selected model across
conversations.

In chat, press Enter to send a line. Superbot prints message text and agent run
errors. `/back` returns to the picker, or exits a directly opened chat. `/quit`
exits from either mode.

### Create and share a workspace

Sign in to the server first. Every account starts with its own Personal Space.
Each additional workspace has its own membership and starts with its creator.

~~~powershell
superbot workspaces list
superbot workspaces create "Weekend plans"
superbot workspaces invite --space "Weekend plans"
superbot workspaces join "<invite URL>"
superbot workspaces members --space "Weekend plans"
superbot workspaces leave --space "Weekend plans"
~~~

An invite link is valid for seven days and can be claimed once. The person who
used it can reopen it while they remain a member. After leaving, ask the owner
for a new invite. Use a Space ID if names are ambiguous. Join uses the origin
in the invite and that origin?s saved session. Workspace commands work before
a model is connected.

### Local models on Windows and macOS

In the desktop app, select an installed CLI model for the bot. On the same
device, both `superbot NAME` and the terminal picker use that selection when
signed into the same server, account and Space. Keep the selected provider's
CLI installed and signed in. Bots without a local selection use the server's
model connection.

Local turns use recent shared conversation history and save the prompt and reply
to the same chat. If saving fails after the model replies, reopen the chat
and type `/retry` to save that turn without running the model again.

### Import bot names into a shared Space

Create a private UTF-8 JSON file such as `{"names":["Ada","Scout"]}`. A member with
permission to create bots in the destination Space can preview and apply the list.
Run the import once on either client. Every member sees the same bots on the server.

```sh
superbot --space Personal import-bots roster.json --dry-run
superbot --space Personal import-bots roster.json
```

Use a Space ID if several Spaces share a name. The importer creates missing names with
the server defaults. It preserves existing and archived bots, checks the whole file
before creating any bots, and can resume after a network interruption. Name matching
ignores case and surrounding whitespace. The file contains names only. Conversation
history, model credentials, permissions and instructions stay with their source.

For a supported tool approval, Superbot prints the server's card, including any
destination and argument preview. In an interactive terminal, enter `1` for
**Allow once** or `2` for **Deny**. Enter without a choice, end of input, and
redirected input or output all leave the card pending. Reopening the chat
offers any supported approval still waiting in its latest message page.

Use Superbot for typed and secret cards, including passwords, login forms and
one-time codes. Also use Superbot for tool-question forms, connection cards,
payment receipts, editable drafts or settings changes, and persistent approval
choices. Attachments open in Superbot.

Run the isolated client and CLI tests from the repository root.

```shell
cargo test -p superbot-client -p superbot-cli
```

On Windows, use the isolated PostgreSQL chat verifier with `--local-cli` to
exercise named chat, the picker, shared history and retry with a synthetic CLI.
See the [chat verification guide](../../docs/superbot/chat-verification.md).
