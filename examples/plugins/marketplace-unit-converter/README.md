# Unit converter marketplace plugin

This first-party example converts temperatures between Celsius and Fahrenheit.
The server performs a calculation in memory. It needs Node.js 24 and has no
package dependencies, credentials or outbound requests.

## Run locally

From the repository root, start the sample on a free loopback port.

```sh
node examples/plugins/marketplace-unit-converter/server.ts 0
```

The server prints its URL. Substitute the printed port for `PORT` in this
request, using `curl.exe` on Windows.

```sh
curl -s http://127.0.0.1:PORT/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"convert_temperature","arguments":{"value":100,"from":"celsius","to":"fahrenheit"}}}'
```

The response includes `"structuredContent":{"value":212,"unit":"fahrenheit"}`.
The server also supports MCP initialization and tool listing. Its tool
declares `ui://unit-converter/temperature.html` in `_meta.ui.resourceUri`.
To inspect the document with the same local request, use this JSON body.

```json
{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://unit-converter/temperature.html"}}
```

In web and mobile chat, Superbot reads the document after the approved
conversion succeeds. The card displays the structured result and lets the
reader adjust the display precision.

To exercise the server through Rakazo's isolated executor fixture, run this
from the repository root after installing dependencies and generating the
Prisma client.

```sh
pnpm exec vitest run packages/adapters/src/runs/executor/executor-readonly-approval.test.ts -t 'marketplace plugin dispatch'
```

The fixture starts the real sample on a free loopback port and routes the test
MCP transport to it. It exercises discovery, approval, replay and denial paths
without contacting external services or a running Rakazo deployment.

The disposable PostgreSQL suite (`pnpm test:integration`) also runs
[the marketplace MCP App chat test](../../../packages/testkit/src/product/marketplace-mcp-app.postgres.test.ts).
It checks the saved card and its HTML in the approved conversation,
including when another conversation or account tries to open it.

The marketplace rejects the local HTTP URL. To install the example in a
deployment, follow the [authoring tutorial](../../../docs/superbot/build-a-marketplace-plugin.md).
