# How installed apps run

This page is for people working on Superbot itself: how the worker turns an installed app's
granted parts into tools. The request and response shapes are in the [registry API](plugin-contract.md).
The worker consumes `resolvePluginGrants(prisma, { spaceId, userId, botId })` from
`@rakazo/db`. Each row identifies an installation, immutable version and manifest part.
The runtime passes the persisted run's Space, account and exact bot. It excludes runs
under a different account from the bot's owner, shared-channel runs, and creation
intros.

The runtime adapter lives in `packages/adapters/src/integrations/marketplace-runtime.ts`.
It translates granted parts into regular Superbot connector tools. Calls go through
the existing executor, approval queue, and effect recording. The internal route
binds an approval to the installation, version, part and tool schema. Arguments are
restored from the approval record on replay. Execution checks the live grant again
after approval. Skills return Markdown as untrusted tool output. MCP calls require a
person's approval each time. The Never ask mode refuses new MCP calls.

The execution identity includes the registry's `grantId` for each granted part.
Removing a grant and adding it again creates a fresh identity. Outstanding
approvals for the removed grant cannot authorize the new one.

A granted `app` part provides `list_records` and `add_record` in an
owner-started direct conversation. The tool schema comes from the installed
version's field definitions. The list can filter by date and returns the same
total as the personal app. An addition goes through one-time approval.
The server derives the write's operation ID from the tool effect so retrying
the same effect can only add one record. The human app also supports removal.
Both paths use the same installation and database row. The database checks the
current grant when the bot reads or writes, including after an approval wait.

Discovery fetches tool schemas only for granted MCP parts. Each call asks
through the standard approval card with the destination and arguments. After
approval, the worker reconnects through the guarded Streamable HTTP transport,
checks that the current tool schema and declared UI resource URI match the
approved route, and rechecks the live grant before sending each HTTP request.
Private addresses and redirects are refused. A request already sent may
finish after revocation.

After a successful chat call, the worker can read the approved `ui://`
resource through the same MCP session. It accepts a matching
`text/html;profile=mcp-app` document within the MCP App size limit. The
existing sandboxed viewer loads the document as a hidden artifact from the
conversation containing the card. An absent or invalid document leaves the
tool result available to the bot.

Registry execution has no command runner, package installer, local network
override or plugin credentials. The test fixture starts the first-party sample
on an isolated loopback port and injects transport routing only in the test.
Production uses the public HTTPS endpoint declared in the approved manifest.

See [Publish to the Store](build-a-marketplace-plugin.md) for submission,
installation and the sample walkthrough.
