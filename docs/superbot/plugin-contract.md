# Registry API

The Store's apps are published, reviewed and installed through the typed Superbot RPC namespace `pluginRegistry` under `/rpc/pluginRegistry/<procedure>`. Every procedure uses the authenticated session and selected Space. Publisher ownership is tied to the authenticated account. Workspace installations are owned by the installing account and isolated by both account and Space.

## Manifest schema 1

```json
{
  "schemaVersion": 1,
  "name": "Release notes",
  "description": "Draft release notes from issue summaries.",
  "parts": [
    {
      "id": "notes",
      "kind": "skill",
      "instructions": "Summarize the provided issue descriptions."
    },
    {
      "id": "tracker",
      "kind": "mcp",
      "transport": "streamable_http",
      "endpoint": "https://tracker.example.com/mcp"
    }
  ]
}
```

Parts have unique lowercase identifiers. A skill carries Markdown instructions. An MCP part declares a public HTTPS Streamable HTTP endpoint. Manifests accept no credentials, headers, commands, packages, hooks, or arbitrary fields. A manifest has 1 to 16 parts. Slugs and part IDs have up to 64 characters. An MCP URL cannot contain a query or fragment. A version is a positive 32-bit integer scoped to a globally unique lowercase plugin slug. The parsed manifest is stored as an immutable snapshot.

An `app` part describes a form and its saved records. The registry owns the records, so the person who installed the app and a bot they grant access to can use the same data. A diary, for example, can have three fields and a daily total.

```json
{
  "kind": "app",
  "id": "meals",
  "fields": [
    { "id": "date", "label": "Date", "type": "date", "required": true },
    { "id": "meal", "label": "Meal", "type": "text", "required": true },
    { "id": "kcal", "label": "Calories (kcal)", "type": "number", "required": true }
  ],
  "summaryField": "kcal"
}
```

Each part has 1–16 uniquely named fields. Field IDs use the same syntax as part IDs. Supply a display label of up to 120 characters and an explicit `required` boolean. Omit optional values when empty. Text values are limited to 2,000 characters and must contain a non-space character. Numbers are finite and have an absolute value at most 10¹². Dates are calendar dates in `YYYY-MM-DD` format. An optional `summaryField` names a numeric field in the same part.

## Procedures

| Procedure         | Input                                                      | Result                                             |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `submit`          | `{slug, version, manifest}`                                | Version with status `pending`                      |
| `mine`            | `{after?, limit?}`                                         | Publisher's versions, including review status      |
| `submissions`     | `{status?, after?, limit?}`                                | Deployment admin review queue, defaults to pending |
| `review`          | `{versionId, decision: "approved" \| "rejected", reason?}` | Decided version                                    |
| `discover`        | `{slug?, query?, after?, limit?}`                          | Approved versions only                             |
| `install`         | `{versionId}`                                              | Installation with exact version and current grants |
| `installations`   | `{after?, limit?}`                                         | Actor's installations in the selected Space        |
| `setGrants`       | `{installationId, botId, partIds}`                         | Installation with current grants                   |
| `switchVersion`   | `{installationId, expectedVersionId, versionId}`           | Installation pinned to the requested version       |
| `uninstall`       | `{installationId}`                                         | `{ok: true}`                                       |
| `appRecords`      | `{installationId, partId, after?, limit?, date?}`          | `{items, nextAfter, total}`                        |
| `addAppRecord`    | `{installationId, partId, operationId, values}`            | `{id, values, createdAt}`                          |
| `removeAppRecord` | `{installationId, partId, recordId}`                       | `{ok: true}`                                       |

Lists return `{items, nextAfter}` using opaque string cursors. The default limit is 20 and the maximum is 50. Rejection requires a reason. Installation changes emit the `pluginRegistry` Space change frame on `notifications.subscribe`. A version contains `id, slug, version, manifest, status, reason, createdAt, reviewedAt`. An installation contains `id, plugin, grants, createdAt`, where `plugin` is the full approved version and each grant is `{botId, partId}`.

`switchVersion` takes the current installation's `plugin.id` as `expectedVersionId`. The requested version must be approved and belong to the same plugin slug. A successful switch retains the installation ID and clears its grants in one transaction. An approval tied to a cleared grant cannot authorize an MCP call, including after an explicit regrant. When the requested version is already installed, the request returns the current installation and preserves any grants added since the first switch. A stale expected version otherwise returns `CONFLICT`. A missing or inaccessible installation or invalid target returns `NOT_FOUND`.

Discover searches each approved version's slug, manifest name and description for a case-insensitive literal substring. The optional `query` must contain 1 to 120 characters after trimming. Keep the same slug and query filters when following a cursor.

### Reading and writing app records

`appRecords` returns the newest records first. Keep the same date filter when passing `nextAfter` to the next call. A date filter selects the first date field in manifest order. A part without a date field refuses a date filter. The numeric total includes every matching live record, even if the page shows only one. An empty selection returns zero when the part declares a summary field. Parts without a summary return `null`.

Generate one UUID per addition and retain it across retries. Submitting the same operation and values returns the saved row. Reusing that ID with different values or after removal returns a conflict. A person can remove their own installation's records. A granted bot can list records and propose an addition during a supported owner-started run. An addition requires approval before it writes.

Data belongs to one account's installation in one Space. Versions keep separate datasets. Switching back to a previous version makes its prior records available again. **Uninstall permanently deletes the installation's records across all versions.** Removing a part grant leaves the installer's data in place.

The first submission reserves the slug for its publisher. Rejected versions remain reserved. If the publisher account is deleted, the slug remains reserved and already approved versions stay available. A new version requires a separate submission and review. Only verified deployment admins may review. A version can be decided once. Approval checks declared MCP endpoints using the existing public endpoint policy. Install is idempotent for an identical version. An existing installation pins its version until a member confirms a change through `switchVersion`. New installations start with zero grants. Setting grants replaces one bot's selected parts and an empty list revokes them. Uninstall or loss of Space membership removes the installation and its grants atomically. Revoking and regranting a part issues a fresh grant ID.

## Configure a deployment reviewer

Set `SUPERBOT_ADMIN_EMAILS` in the private Superbot deployment environment file to a comma-separated list of reviewer email addresses and run `node infra/superbot/host.mjs up` to apply it. This grants each named, verified account deployment administrator access, including review of app releases. An empty list leaves the review queue restricted. Each reviewer signs in with their own account.

With SMTP configured, the reviewer verifies their address using the server's verification email. For a private instance without mail, the operator can provision a verified account with the documented `host.mjs account` command. [Private account bootstrap and SMTP setup](hosting.md)

Run `superbot-plugin list submissions` from the reviewer's session, inspect the proposed manifest, and use `superbot-plugin review VERSION_ID approved` or `superbot-plugin review VERSION_ID rejected --reason "Explain the required change"`. The decision applies to that exact version. [Author and reviewer command reference](plugin-toolkit.md)

## Resolve agent capabilities

Use `resolvePluginGrants(prisma, {spaceId, userId, botId})` from `@rakazo/db` on each capability load. It returns explicitly granted parts with a stable grant ID plus installation and version IDs. Supply the running bot's authoritative scope. Bind tool approvals to the grant ID and check the grant again before invocation. Skills are untrusted instructions. MCP handling must use the existing guarded remote transport and tool approval controls, including runtime endpoint validation and redirect policy. Registry operations never contact MCP tools or execute package content. Runtime materialization is owned by the runtime integration.
