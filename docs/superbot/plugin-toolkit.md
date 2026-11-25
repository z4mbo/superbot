# Superbot plugin toolkit

Install both commands from the repository root: [`superbot`](../../apps/cli/README.md#install-from-the-monorepo) and [`superbot-plugin`](../../apps/plugin-kit/README.md#install-from-the-monorepo). Then sign in.

```sh
superbot login
```

Both programs use the same system credential store entry for the server origin. Set the default for a self-hosted deployment with `superbot server https://superbot.example.com` before signing in. You can override the default with `SUPERBOT_SERVER` or `--server URL`. Commands use your only Space automatically. If you belong to several, pass `--space` with an exact Space name or ID.

Create a starter skill in a new working directory, then edit `plugin.json` and validate it.

```sh
mkdir release-notes
cd release-notes
superbot-plugin init release-notes --name "Release notes"
superbot-plugin validate
superbot-plugin publish release-notes 1
superbot-plugin list mine
```

Choose your own slug if `release-notes` is already reserved. Copy the submitted version's `id` into `VERSION_ID` in the examples below. Run `superbot-plugin status VERSION_ID` to check its review status and any rejection reason. Registry commands print JSON. List commands return a `nextAfter` cursor when there is another page. Pass it as `--after` with the same scope and filters.

A verified deployment admin can review from their own signed-in session.

```sh
superbot-plugin list submissions
superbot-plugin review VERSION_ID approved
# To reject a pending version instead:
superbot-plugin review VERSION_ID rejected --reason "Clarify the skill instructions"
```

After approval, discover and install the version in the intended Space. Copy the installation's `id` and the agent's `id` into `INSTALLATION_ID` and `BOT_ID`. The starter manifest's part ID is `summary`.

```sh
superbot-plugin list discover --slug release-notes
superbot-plugin install VERSION_ID
superbot-plugin list installations
superbot-plugin agents
superbot-plugin set-grants INSTALLATION_ID BOT_ID summary
```

Search all approved versions with `superbot-plugin list discover --query "release notes"`. Pass the same query when continuing with `--after`.

Each grant command replaces the selected agent's full grant list for that installation. Omit the part IDs to revoke that agent's grants. Run `superbot-plugin uninstall INSTALLATION_ID` to remove the installation and all its grants.

To change a pinned version, copy the current `plugin.id` from `list installations` and pick an approved version of the same plugin from `list discover`.

```sh
superbot-plugin switch-version INSTALLATION_ID CURRENT_VERSION_ID TARGET_VERSION_ID
```

The switch keeps the installation ID and clears all grants. Grant the desired parts again after reviewing the new version. If the current version changed before the switch, list installations again to find the current pin.

## Create a TypeScript MCP app

Use Node.js 24 to run the starter in an empty project directory.

```sh
mkdir temperature-tool
cd temperature-tool
superbot-plugin init temperature-tool --template mcp-app
superbot-plugin validate
node server.ts
```

The command writes `plugin.json`, `server.ts`, and `README.md`. The generated
README includes the local request that converts 100 Celsius to 212 Fahrenheit
and instructions for putting your tool behind a public HTTPS reverse proxy.
Set the manifest endpoint to your public `/mcp` URL before publishing. Despite
its name, `mcp-app` is an MCP tool server you host, not a record app. The MCP
part ID is `temperatures` and the optional skill part ID is `conversion-guide`.
With `--manifest`, the server and README are created next to the specified
manifest. The destination directory must already exist.

## Create a record app

A record app is a list of fields whose entries the Superbot server stores. It
needs no server or code of your own. Start from the Calorie diary in an empty
directory and submit it under your own slug, because `kcal-diary` belongs to
the bundled diary.

```sh
mkdir water-log
cd water-log
superbot-plugin init water-log --template kcal-diary --name "Water log"
superbot-plugin validate
superbot-plugin publish water-log 1
```

The `kcal-diary` template writes only `plugin.json`. Without `--name`, it
matches [`examples/plugins/kcal-diary/plugin.json`](../../examples/plugins/kcal-diary/plugin.json):
one `app` part, `meals`, with required `date`, `meal` and `kcal` fields and
`kcal` as the total. Edit the fields before validating. Each app part has 1 to
16 fields with an `id`, `label`, `type` of `text`, `number` or `date`, and an
explicit `required`. An optional `summaryField` names a number field.
`validate` applies the registry's limits locally. The
[registry contract](plugin-contract.md) lists them.

`superbot-plugin` only scaffolds, validates and submits manifests. It has no
commands to open an app, read, add or remove entries, or show totals. People
use the app in Superbot, and programs call the `appRecords`, `addAppRecord` and
`removeAppRecord` procedures.

See the [registry contract](plugin-contract.md) for manifest fields. Local validation checks the manifest schema without contacting the server. The registry checks MCP endpoint safety during approval.

Run deterministic tests from the repository root.

```sh
pnpm --filter superbot-plugin-kit test
```
