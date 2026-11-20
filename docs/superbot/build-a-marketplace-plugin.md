# Author a marketplace plugin

A marketplace plugin is a versioned manifest. It can give a bot instructions
through a skill, or tools through a public HTTPS MCP endpoint. The registry
takes the manifest object directly through `pluginRegistry.submit`. See the
[registry contract](plugin-contract.md) for the full API and publication rules.

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

Start a turn with that bot. Ask it to use the marketplace converter to convert
100 Celsius to Fahrenheit. Check that the approval card shows the converter's
endpoint and the conversion arguments, then choose **Allow once**. The tool
returns a structured value of `212` and a unit of `fahrenheit`. In a Space set
to **Never ask**, the remote call is refused.

To revoke both parts for this bot, pass `partIds: []` to `setGrants`. The call
fails if you revoke the grant before answering its approval. Other bots need
their own grants. Uninstalling removes the grants for all bots in that Space.

## Manifest and endpoint reference

| Field or part            | What to provide                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`          | The integer `1`.                                                                                                               |
| `name` and `description` | A short display name and a description of the job the plugin does.                                                             |
| `parts`                  | One to sixteen entries, each with a unique lowercase, hyphen-separated `id`.                                                   |
| `kind: "skill"`          | An `instructions` string containing Markdown. The bot can read it as tool output when granted.                                 |
| `kind: "mcp"`            | Set `transport` to `streamable_http` and `endpoint` to a public HTTPS URL without credentials, query parameters or a fragment. |

Use a short description and a JSON object input schema for each MCP tool. Define
the required fields and validate the arguments again on your server. Use
structured results for predictable data. Marketplace approvals include the
remote tool, endpoint and arguments, so keep payloads short enough to review.
Superbot exposes up to twenty tools per granted endpoint and rechecks the selected
tool schema before calling it. Publish a new marketplace version when changing
the manifest or shipping an incompatible tool contract.

The endpoint should support MCP initialization, `tools/list` and `tools/call`
over Streamable HTTP. Discovery opens an MCP connection before asking for an
individual call's approval. Keep discovery free of side effects. Treat the
service as public and apply your own resource limits at the proxy. Marketplace
manifests permit neither authentication materials nor local code entry points.
The worker sends only MCP protocol requests and the approved tool arguments. A
redirect or private address fails runtime validation. See the
[runtime reference](plugin-runtime.md) for approval and grant handling.
