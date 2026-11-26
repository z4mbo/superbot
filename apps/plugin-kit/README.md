# superbot-plugin

`superbot-plugin` creates, validates and publishes plugins for the Superbot registry, and installs
and grants approved versions in a Space. It also creates, checks and submits apps built with the
[Apps SDK](../../docs/plugin-sdk.md). It is a single bundled JavaScript file that runs under
Node.js 24 or later on Linux, macOS and Windows.

## Install from the monorepo

From the repository root, install the workspace and build the command.

```sh
pnpm install
pnpm --filter superbot-plugin-kit build
```

Run the bundle with Node.js from the folder you work in, since manifest paths are relative to it:

```sh
node path/to/superbot/apps/plugin-kit/dist/superbot-plugin.mjs --help
```

`pnpm --filter superbot-plugin-kit exec node dist/superbot-plugin.mjs --help` also works, but it
runs inside `apps/plugin-kit`, so relative manifest paths resolve there.

To put `superbot-plugin` on your `PATH`, link the package globally (pnpm's global bin directory
must be set up once with `pnpm setup`), then rebuild after pulling changes:

```sh
cd apps/plugin-kit
pnpm link --global
superbot-plugin --version
```

Remove the link with `pnpm remove --global superbot-plugin-kit`.

The bundle loads the system credential store binding from this package's dependencies, so keep
it inside the monorepo checkout rather than copying `dist/` elsewhere.

## Sign in

Registry commands use the session that `superbot login` saved for the same server: the system
credential store entry, or `sessions.json` in the Superbot settings folder when the computer has
no credential store. The server is `--server URL`, else `SUPERBOT_SERVER`, else the one saved on
this computer, else the local default. Commands use your only Space automatically; when you
belong to several, pass `--space` with an exact Space name or ID. Both options go before or after
the command.

## Commands

Registry commands print the server's answer as indented JSON. List commands return a `nextAfter`
cursor when there is another page; pass it as `--after` with the same scope and filters.

| Command                                                                             | What it does                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init SLUG [--name NAME] [--manifest PATH] [--template skill\|mcp-app\|kcal-diary]` | Creates a starter skill (default), TypeScript MCP app, or record app. Alias: `scaffold`. The manifest defaults to `plugin.json`; the MCP app also writes `server.ts`, `temperature.html` and `README.md` beside it. Existing files are never overwritten.                           |
| `validate [MANIFEST]`                                                               | Checks a manifest against the registry's rules locally. Defaults to `plugin.json`.                                                                                                                                                                                                  |
| `app-init FOLDER [--name NAME]` | Creates an app folder (`app.json`, `app.jsx`, `server.js`) from the Food Diary starter: hosted records, server functions and a card. The folder's name becomes the app id. Existing files are never overwritten. |
| `app-check [FOLDER]` | Checks an app folder the way the server does before it takes it: the manifest, the entry, and the server file. Defaults to the current folder. |
| `app-publish [FOLDER]` | Checks an app folder and submits its version for review. Once a deployment admin approves it, it is listed in the Store's Apps section. |
| `publish SLUG VERSION [--manifest PATH]`                                            | Submits a version (1 to 2147483647) for review. Alias: `submit`.                                                                                                                                                                                                                    |
| `list [discover\|mine\|installations\|submissions]`                                 | Lists approved versions (default), your submissions, the Space's installations, or the reviewer queue. Takes `--after CURSOR` and `--limit 1..50` (default 20). `discover` also takes `--slug SLUG` and `--query TEXT`; `submissions` takes `--status pending\|approved\|rejected`. |
| `status VERSION_ID`                                                                 | Shows one of your submitted versions, with its review status and any rejection reason.                                                                                                                                                                                              |
| `agents`                                                                            | Lists the Space's agents and their IDs for grants.                                                                                                                                                                                                                                  |
| `install VERSION_ID`                                                                | Installs an approved version in the Space.                                                                                                                                                                                                                                          |
| `switch-version INSTALLATION_ID EXPECTED_VERSION_ID VERSION_ID`                     | Moves an installation to another approved version and clears all of its grants.                                                                                                                                                                                                     |
| `set-grants INSTALLATION_ID BOT_ID [PART_ID...]`                                    | Replaces one agent's grants (at most 16 part IDs). Omit the part IDs to revoke them all. Alias: `grant`.                                                                                                                                                                            |
| `uninstall INSTALLATION_ID`                                                         | Removes an installation and its grants.                                                                                                                                                                                                                                             |
| `review VERSION_ID approved\|rejected [--reason TEXT]`                              | Approves or rejects a pending submission as a deployment admin. A rejection needs `--reason`.                                                                                                                                                                                       |
| `help [COMMAND]`                                                                    | Prints help. `-h` prints a summary and `--help` the full help.                                                                                                                                                                                                                      |

`--version` prints the version. Usage errors exit with status 2 and other failures with status 1.

## Develop

```sh
pnpm --filter superbot-plugin-kit check
pnpm --filter superbot-plugin-kit test
```

The tests run offline against an in-process registry on a loopback port, with a fake credential
store and temporary settings folders. One test bundles the command and runs it under plain Node;
another starts the scaffolded MCP app and calls its tool.
