# Temperature converter MCP app

This TypeScript starter serves a tool that converts Celsius and Fahrenheit.
It needs Node.js 24 and has no package dependencies.

## Test locally

In this directory, start the server.

```sh
node server.ts
```

In another terminal, send a Streamable HTTP MCP request. In PowerShell, use
the following command.

```powershell
$body = @{
  jsonrpc = "2.0"
  id = 1
  method = "tools/call"
  params = @{
    name = "convert_temperature"
    arguments = @{ value = 100; from = "celsius"; to = "fahrenheit" }
  }
} | ConvertTo-Json -Depth 5 -Compress
Invoke-RestMethod http://127.0.0.1:8787/mcp -Method Post -ContentType application/json -Headers @{ Accept = "application/json, text/event-stream" } -Body $body |
  ConvertTo-Json -Depth 5
```

In a POSIX shell, use this command.

```sh
curl -sS http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"convert_temperature","arguments":{"value":100,"from":"celsius","to":"fahrenheit"}}}'
```

The result's `structuredContent` contains `value: 212` and `unit: "fahrenheit"`.
If port 8787 is in use, run `node server.ts 0` and substitute the printed port.

## Deploy and publish

1. To build your own tool, edit the tool definition and argument validation
   in `server.ts` together. Update the manifest description and skill to match
   the tool's behavior.
2. On your host, run `node server.ts` as a service and keep its listener on
   loopback. Configure a reverse proxy with a public DNS name and TLS
   certificate to forward `POST /mcp` to `http://127.0.0.1:8787/mcp` on that
   host. Apply request limits at the proxy.
3. Replace the MCP part's placeholder endpoint in the manifest with that
   public HTTPS URL. Repeat the local test against the public URL.
4. Run `superbot-plugin validate`, sign in with `superbot login`, then run
   `superbot-plugin publish YOUR_SLUG 1` to submit for review. Use the slug
   you supplied to `init`. If you initialized with a custom manifest path,
   pass that path to `validate` and use `--manifest` with `publish`.
5. After approval, install the version and grant its `temperatures` part to
   the agent that should use the tool. The `conversion-guide` part supplies an
   optional skill.
