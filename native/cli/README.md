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

Pass `--server https://rakazo.example.com` for self-hosted Rakazo, or set
`SUPERBOT_SERVER` to use that server on each invocation. The URL must be an HTTPS
origin. A local development server can use a loopback HTTP origin such as
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
