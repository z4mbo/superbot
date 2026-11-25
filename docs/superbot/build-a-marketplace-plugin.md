# Publish to the Store

Everything listed in the Store's **Apps** section is a versioned manifest. It
can give a bot instructions through a skill, tools through a public HTTPS MCP
endpoint, or a record app whose entries Superbot stores. You submit a version,
a deployment admin reviews it, and once approved people install it from the
Store. The registry takes the manifest object directly through
`pluginRegistry.submit`; the [command-line toolkit](plugin-toolkit.md) does
the same from a terminal. See the [registry API](plugin-contract.md) for the
full API and publication rules.

Use a record app for fields Superbot displays in a form and stores for the
installer. Use an MCP App to add an interactive view to a bot's tool result.
The `mcp-app` starter in the [command-line toolkit](plugin-toolkit.md) scaffolds
the MCP tool server you host.

## Try the Calorie diary

The bundled **Calorie diary** is an approved record app with the slug
`kcal-diary`. The database migration publishes it on servers where nobody else
holds that slug. Its manifest has one `app` part, `meals`, with a required
`date`, `meal` text and `kcal` number, and totals `kcal`.

Nothing is installed in advance. Each account installs the diary in a Space,
and its entries belong to that account in that Space. The installer and the
bots they grant `meals` to see the same entries.

```ts
const { items } = await installer.pluginRegistry.discover({ slug: "kcal-diary" });
const release = items.find((item) => item.version === 1);
if (!release) throw new Error("Version 1 is unavailable");

const installation = await installer.pluginRegistry.install({ versionId: release.id });
const target = { installationId: installation.id, partId: "meals" };

await installer.pluginRegistry.addAppRecord({
  ...target,
  operationId: crypto.randomUUID(),
  values: { date: "2026-11-20", meal: "Porridge", kcal: 480 },
});

const today = await installer.pluginRegistry.appRecords({ ...target, date: "2026-11-20" });

await installer.pluginRegistry.setGrants({
  installationId: installation.id,
  botId,
  partIds: ["meals"],
});
```

`today.total` is `480`: the sum of every entry on that date, not only the
returned page. Keep an `operationId` for each addition and reuse it when retrying. Entries
can't be edited: remove one with `removeAppRecord` and add a corrected entry.
Only people remove entries.

In a direct chat with the granted bot, ask for today's total. The bot can list
entries without an approval card. Ask it to add a 220 kcal snack. The approval
card shows the values, and nothing is saved until you choose **Allow once**. A
Space set to **Never ask** refuses the addition. The bot gets these actions
only in a direct chat with the installer, in a turn the installer's own message
started. With a supported local model, open `superbot <agent>` and enter
`/apps` to see its granted apps. For example, if the diary is item 1,
`/app 1 --date 2026-04-03 How many calories did I log?` sends the selected day's
total and up to five records to that model. A proposed addition shows its
field values and requires typing `save`. This interaction stays outside the shared chat.

Revoking the grant keeps the entries. Each version keeps its own entries, and
switching back to a version shows its earlier entries again. Uninstalling
permanently deletes the entries of every version.

## Try the unit converter

The [first-party example](../../examples/plugins/marketplace-unit-converter/README.md)
has a temperature tool and a short skill. Start with its local smoke test.
To use the example with a running deployment, host the sample behind a public
HTTPS reverse proxy. Replace the placeholder endpoint in the sample
[manifest](../../examples/plugins/marketplace-unit-converter/manifest.json)
with the proxy's exact `/mcp` URL. Keep the local listener bound to loopback.

Submit the edited manifest using the authenticated publisher's typed RPC
client. The following calls use separate publisher, deployment admin and
installer sessions.

```ts
const pending = await publisher.pluginRegistry.submit({
  slug: "unit-converter",
  version: 1,
  manifest,
});

await admin.pluginRegistry.review({
  versionId: pending.id,
  decision: "approved",
});
```

Select the Space containing your bot in the installer's session. Look up the
approved version, install it and grant both parts to that bot.

```ts
const { items } = await installer.pluginRegistry.discover({ slug: "unit-converter" });
const release = items.find((item) => item.version === 1);
if (!release) throw new Error("Version 1 is unavailable");

const installation = await installer.pluginRegistry.install({ versionId: release.id });
await installer.pluginRegistry.setGrants({
  installationId: installation.id,
  botId,
  partIds: ["temperatures", "conversion-guide"],
});
```

Start a turn with that bot. Ask it to use the Store converter to convert
100 Celsius to Fahrenheit. Check that the approval card shows the converter's
endpoint and the conversion arguments, then choose **Allow once**. The tool
returns a structured value of `212` and a unit of `fahrenheit`. In a Space set
to **Never ask**, the remote call is refused. In web and mobile chat, the
successful call also shows a temperature card with a control for display precision.

To revoke both parts for this bot, pass `partIds: []` to `setGrants`. The call
fails if you revoke the grant before answering its approval. Other bots need
their own grants. Uninstalling removes the grants for all bots in that Space.

### Add a view to your MCP tool

Keep the Store manifest's `mcp` part pointed at your public HTTPS endpoint.
In `tools/list`, set the tool's `_meta.ui.resourceUri` to a `ui://` URI.
Advertise the MCP `resources` capability and serve that exact URI from
`resources/read` on the same endpoint. Return the matching `uri`,
`mimeType: "text/html;profile=mcp-app"` and document `text` in the resource's
`contents` array. The document limit is 2 MB.

Superbot reads the resource after the approved tool call succeeds. Its
sandboxed chat card sends the tool arguments and result after the view
initializes. The sample [temperature view](../../examples/plugins/marketplace-unit-converter/temperature.html)
uses the structured result and runs its precision control in the card.
For another tool action, offer text to the composer and let the person send
it. The card cannot call tools directly.

## Manifest and endpoint reference

| Field or part            | What to provide                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`          | The integer `1`.                                                                                                                               |
| `name` and `description` | A short display name and a description of the job the app does.                                                                                |
| `parts`                  | One to sixteen entries, each with a unique lowercase, hyphen-separated `id`.                                                                   |
| `kind: "skill"`          | An `instructions` string containing Markdown. The bot can read it as tool output when granted.                                                 |
| `kind: "mcp"`            | Set `transport` to `streamable_http` and `endpoint` to a public HTTPS URL without credentials, query parameters or a fragment.                 |
| `kind: "app"`            | One to sixteen `fields`, each with `id`, `label`, `type` (`text`, `number` or `date`) and `required`, plus an optional numeric `summaryField`. |

Use a short description and a JSON object input schema for each MCP tool. Define
the required fields and validate the arguments again on your server. Use
structured results for predictable data. Approvals for these calls include the
remote tool, endpoint and arguments, so keep payloads short enough to review.
A bot is offered every tool its granted apps expose. Up to twenty in total are
listed directly; above that the bot searches for a tool, loads its schema and runs
it through a catalog, so give each tool a name and description a search can find.
Superbot rechecks the selected tool schema before calling it. Publish a new version when changing
the manifest or shipping an incompatible tool contract.

The endpoint should support MCP initialization, `tools/list` and `tools/call`
over Streamable HTTP. Discovery opens an MCP connection before asking for an
individual call's approval. Keep discovery free of side effects. Treat the
service as public and apply your own resource limits at the proxy. Store
manifests permit neither authentication materials nor local code entry points.
The worker sends only MCP protocol requests and the approved tool arguments. A
redirect or private address fails runtime validation. See the
[runtime reference](plugin-runtime.md) for approval and grant handling.

### Test-only: plugin servers on a private address

Isolated test stacks that run fake plugin servers next to the API can set
`SUPERBOT_E2E_ALLOW_PLUGIN_HOSTS` on the API and the worker. It takes a
comma-separated list of exact hostnames or IP literals, such as `127.0.0.1`.
Only plugin endpoints on those hosts may then resolve to private or loopback
addresses, at review and at runtime. The endpoint must still use HTTPS, so
the test stack serves it with a certificate its processes trust through
`NODE_EXTRA_CA_CERTS`. The setting is unset by default, no deployment file sets
it, and it is ignored when `NODE_ENV=production`. Never set it on a server
other people use.
