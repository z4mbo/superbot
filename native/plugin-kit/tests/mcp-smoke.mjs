import assert from "node:assert/strict";
import { once } from "node:events";
import { createConverterServer } from "./server.ts";

const server = createConverterServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const call = async (id, method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, id);
    return reply.result;
  };
  const initialization = await call(1, "initialize", { protocolVersion: "2025-11-25" });
  assert.equal(initialization.protocolVersion, "2025-11-25");

  const listing = await call(2, "tools/list");
  assert.equal(listing.tools[0].name, "convert_temperature");
  assert.deepEqual(listing.tools[0].inputSchema.required, ["value", "from", "to"]);

  const conversion = await call(3, "tools/call", {
    name: "convert_temperature",
    arguments: { value: 100, from: "celsius", to: "fahrenheit" },
  });
  assert.deepEqual(conversion.structuredContent, { value: 212, unit: "fahrenheit" });
} finally {
  server.close();
}
