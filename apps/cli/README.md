# superbot

`superbot` chats with your Superbot agents from a terminal. It connects to an existing Superbot
server; you need an account in a Space with an agent. Agents can use the server's model
connection or a supported CLI installed on this device.

## Install from npm

The command will be published to npm as `superbot-cli`; it is not on npm yet, so install it from
the monorepo below for now. Once it is published:

```shell
npx superbot-cli --help
npm install -g superbot-cli
superbot --version
```

It needs Node.js 24.15 or newer.

## Install from the monorepo

The command is a bundled Node.js script (Node 24.15 or newer) that runs the same way on Linux,
macOS and Windows. From the repository root:

```shell
pnpm install
pnpm --filter superbot-cli build
pnpm --filter superbot-cli exec superbot --help
```

To call it as `superbot` anywhere, link the package globally once (`pnpm setup` first if pnpm
has no global bin folder yet):

```shell
cd apps/cli
pnpm link --global
superbot --version
```

Rebuild after pulling changes. `node apps/cli/bin/superbot.js` also runs it without linking.

## Sign in

```shell
superbot signup
superbot login
superbot login --code
printf '%s' "$PASSWORD" | superbot login --email you@example.com --password-stdin
superbot whoami
superbot logout
```

`signup` creates an account when the server allows registration. `login` asks for your password
or, with `--code`, an emailed sign-in code; neither is shown while you type. Scripts pipe the
password with `--password-stdin`, which needs `--email`. `logout` revokes the session and removes
it from this device.

## Servers

```shell
superbot server
superbot server https://superbot.example.com
```

`superbot server` prints the server in use; with a URL it saves the default for this device. For
one command, `--server URL` takes precedence over `SUPERBOT_SERVER`, which takes precedence over
the saved server. Without any of them the command uses `http://127.0.0.1:5173`. The server must
be an HTTPS origin, or HTTP on this computer's loopback address for a local server.

## Where the session is kept

Each server's signed session is saved in the system credential store: Windows Credential Manager,
the macOS Keychain, or the Secret Service on Linux. When no credential store is available, such as
on a Linux server without a Secret Service, the session is saved in `sessions.json` in the
settings directory instead, readable only by you (mode `0600`), and the command says so when you
sign in.

The settings directory is `SUPERBOT_CONFIG_DIR` when it is set. Otherwise it is
`$XDG_CONFIG_HOME/superbot` (or `~/.config/superbot`) on Linux,
`~/Library/Application Support/Superbot` on macOS, and `%LOCALAPPDATA%\Superbot` on Windows. It
also holds the saved server (`server.txt`), the local model settings and the last update check.

## Chat

```shell
superbot
superbot "Research agent"
superbot --space "My space" "Research agent"
superbot chat "Research agent" --new-conversation
superbot chat "Research agent" --conversation THREAD_ID
superbot list
```

Without a name, `superbot` lists your agents with their Spaces and asks for a number. A name
matches exactly first, then ignoring case when only one agent matches. Use `superbot chat NAME`
for an agent named like a command. `--new-conversation` starts another conversation with the
agent and prints its ID; `--conversation` reopens one by the ID that `threads list` shows.

Type a line and press Enter to send it; the reply prints as the agent writes it. `/back` returns to
the picker and `/quit` exits. When a reply stops on a supported approval, enter `1` to allow it
once or `2` to deny it; anything else leaves it waiting.

Agents that use a CLI installed on this device run it here, on the conversation's recent history,
and save the turn to the shared conversation. If saving fails, type `/retry` to save it without
running the model again. With a prompt-only local model, `/apps` lists the record apps granted to
the agent, `/apps next` shows more, `/app NUMBER [--date YYYY-MM-DD] [REQUEST]` previews records
and asks the model for help, `/app retry` finishes an approved save and `/app discard` drops it.

## Full-screen chat

`superbot tui` shows your agents, their conversations and the open chat side by side, with
approvals in their own panel while any are waiting. Tab moves between panels. In a list, the
arrow keys select, Enter opens, `n` starts a conversation, `a` allows and `d` denies an approval,
Esc goes to the composer and `q` quits. In the composer, Enter sends, PgUp and PgDn scroll and
Esc returns to the agents. Ctrl+C quits from anywhere. `--space` picks the Space.

## Scripts

```shell
superbot send "Research agent" "Summarize today's notes"
git diff | superbot send "Research agent"
superbot threads list "Research agent"
superbot threads show "Research agent" THREAD_ID
superbot approvals
superbot approvals allow ID
superbot approvals deny ID
```

`send` prints only the reply. Without a message it reads standard input. `--conversation` and
`--new-conversation` work as they do for `chat`. `threads show` prints the first conversation when
no ID is given. `approvals` lists the cards waiting on you across your agents and conversations.

Add `--json` to `whoami`, `list`, `send`, `threads` and `approvals` for JSON output.
`SUPERBOT_SPACE` selects a Space like `--space`. Commands exit with `0` on success, `1` on
failure (including a failed or cancelled reply) and `2` for a usage error; `send` exits with `3`
when the reply stops on a card that needs your answer.

## Workspaces

```shell
superbot workspaces list
superbot workspaces create "Weekend plans"
superbot workspaces invite --space "Weekend plans"
superbot workspaces join "<invite URL>"
superbot workspaces members --space "Weekend plans"
superbot workspaces leave --space "Weekend plans"
```

An invite link is valid for seven days and can be claimed once. `join` uses the server in the
link and that server's saved session. Use a Space ID when names are ambiguous.

## Import agent names

```shell
superbot --space Personal import-bots roster.json --dry-run
superbot --space Personal import-bots roster.json
```

The file is UTF-8 JSON such as `{"names":["Ada","Scout"]}`. The import creates the names the Space
does not have yet, ignoring case and surrounding spaces, keeps existing and archived agents, checks
the whole file first, and can be run again to resume.

## Updates

`superbot update` asks the npm registry for the latest release and prints the command that
updates this copy, such as `npm install -g superbot-cli@latest` or `pnpm add -g
superbot-cli@latest`, depending on how it was installed. It prints the command rather than running
it, since a global install can need permissions you grant yourself. `--json` prints the result as
JSON.

An installed copy also checks the registry in the background at most once a day and, when a newer
release is out, says so on standard error after a command finishes. The check runs in a separate
process, so no command waits for it, and a failed check is silent. It never runs in CI
(`CI` set), when standard output or standard error is not a terminal, with `--json`, or in a copy
built from this repository. To turn it off, set `NO_UPDATE_NOTIFIER=1`, the variable other
command-line tools honor; when `npx` runs it, npm's own `update-notifier=false` setting turns it
off as well. The last result is kept
in `update-check.json` in the settings directory.

## Tests

```shell
pnpm exec vitest run apps/cli/src
pnpm test:integration --spec=superbot-cli
```

The unit tests run offline against a loopback server with a temporary settings directory and an
in-memory credential store. The integration test starts the API on a throwaway database and drives
the built command.

Releasing the npm package is described in [Releasing the command-line tool](../../docs/cli-release.md).
