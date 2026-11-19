# Superbot terminal client

Superbot connects to an existing Rakazo server. You need a Rakazo account
that belongs to a space with an agent. The agent or deployment needs a working
model connection.

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

Use `superbot server https://rakazo.example.com` to save the default for the
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

In chat, press Enter to send a line. Superbot prints message text and agent run
errors. `/back` returns to the picker, or exits a directly opened chat.

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
`/quit` exits from either mode.

For a supported tool approval, Superbot prints the server's card, including any
destination and argument preview. In an interactive terminal, enter `1` for
**Allow once** or `2` for **Deny**. Enter without a choice, end of input, and
redirected input or output all leave the card pending. Reopening the chat
offers any supported approval still waiting in its latest message page.

Use Rakazo for typed and secret cards, including passwords, login forms and
one-time codes. Also use Rakazo for tool-question forms, connection cards,
payment receipts, editable drafts or settings changes, and persistent approval
choices. Attachments open in Rakazo.

Run the isolated client and CLI tests from the repository root.

```shell
cargo test -p superbot-client -p superbot-cli
```
