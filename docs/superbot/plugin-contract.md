# Superbot plugin registry contract

The typed Rakazo RPC namespace is `pluginRegistry` under `/rpc/pluginRegistry/<procedure>`. Every procedure uses the authenticated session and selected Space. Publisher ownership is tied to the authenticated account. Workspace installations are owned by the installing account and isolated by both account and Space.

## Manifest schema 1

```json
{
  "schemaVersion": 1,
  "name": "Release notes",
  "description": "Draft release notes from issue summaries.",
  "parts": [
    { "id": "notes", "kind": "skill", "instructions": "Summarize the provided issue descriptions." },
    { "id": "tracker", "kind": "mcp", "transport": "streamable_http", "endpoint": "https://tracker.example.com/mcp" }
  ]
}
```

Parts have unique lowercase identifiers. A skill carries Markdown instructions. An MCP part declares a public HTTPS Streamable HTTP endpoint. Manifests accept no credentials, headers, commands, packages, hooks, or arbitrary fields. A manifest has 1 to 16 parts. Slugs and part IDs have up to 64 characters. An MCP URL cannot contain a query or fragment. A version is a positive 32-bit integer scoped to a globally unique lowercase plugin slug. The parsed manifest is stored as an immutable snapshot.

## Procedures

| Procedure | Input | Result |
| --- | --- | --- |
| `submit` | `{slug, version, manifest}` | Version with status `pending` |
| `mine` | `{after?, limit?}` | Publisher's versions, including review status |
| `submissions` | `{status?, after?, limit?}` | Deployment admin review queue, defaults to pending |
| `review` | `{versionId, decision: "approved" \| "rejected", reason?}` | Decided version |
| `discover` | `{slug?, query?, after?, limit?}` | Approved versions only |
| `install` | `{versionId}` | Installation with exact version and current grants |
| `installations` | `{after?, limit?}` | Actor's installations in the selected Space |
| `setGrants` | `{installationId, botId, partIds}` | Installation with current grants |
| `uninstall` | `{installationId}` | `{ok: true}` |

Lists return `{items, nextAfter}` using opaque string cursors. The default limit is 20 and the maximum is 50. Rejection requires a reason. Installation changes emit the `pluginRegistry` Space change frame on `notifications.subscribe`. A version contains `id, slug, version, manifest, status, reason, createdAt, reviewedAt`. An installation contains `id, plugin, grants, createdAt`, where `plugin` is the full approved version and each grant is `{botId, partId}`.

Discover searches each approved version's slug, manifest name and description for a case-insensitive literal substring. The optional `query` must contain 1 to 120 characters after trimming. Keep the same slug and query filters when following a cursor.

The first submission reserves the slug for its publisher. Rejected versions remain reserved. If the publisher account is deleted, the slug remains reserved and already approved versions stay available. A new version requires a separate submission and review. Only verified deployment admins may review. A version can be decided once. Approval checks declared MCP endpoints using the existing public endpoint policy. Install is idempotent for an identical version. An existing installation pins its version and a switch requires uninstalling and installing explicitly. New installations start with zero grants. Setting grants replaces one bot's selected parts and an empty list revokes them. Uninstall or loss of Space membership removes the installation and its grants atomically. Revoking and regranting a part issues a fresh grant ID.

## Configure a deployment reviewer

Set `RAKAZO_ADMIN_EMAILS` in the private Superbot deployment environment file to a comma-separated list of reviewer email addresses and run `node infra/superbot/host.mjs up` to apply it. This grants each named, verified account deployment administrator access, including review of plugin releases. An empty list leaves the review queue restricted. Each reviewer signs in with their own account.

With SMTP configured, the reviewer verifies their address using the server's verification email. For a private instance without mail, the operator can provision a verified account with the documented `host.mjs account` command. [Private account bootstrap and SMTP setup](hosting.md)

Run `superbot-plugin list submissions` from the reviewer's session, inspect the proposed manifest, and use `superbot-plugin review VERSION_ID approved` or `superbot-plugin review VERSION_ID rejected --reason "Explain the required change"`. The decision applies to that exact version. [Author and reviewer command reference](plugin-toolkit.md)

## Resolve agent capabilities

Use `resolvePluginGrants(prisma, {spaceId, userId, botId})` from `@rakazo/db` on each capability load. It returns explicitly granted parts with a stable grant ID plus installation and version IDs. Supply the running bot's authoritative scope. Bind tool approvals to the grant ID and check the grant again before invocation. Skills are untrusted instructions. MCP handling must use the existing guarded remote transport and tool approval controls, including runtime endpoint validation and redirect policy. Registry operations never contact MCP tools or execute package content. Runtime materialization is owned by the runtime integration.
