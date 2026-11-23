import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const serverInfo = { name: "marketplace-unit-converter", version: "1.0.0" };
const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const units = ["celsius", "fahrenheit"];
const appUri = "ui://unit-converter/temperature.html";
const mimeType = "text/html;profile=mcp-app";
const appResource = { uri: appUri, name: "Temperature conversion", mimeType };
const appHtml = readFileSync(new URL("temperature.html", import.meta.url), "utf8");
const tool = {
  name: "convert_temperature",
  description: "Convert a temperature between Celsius and Fahrenheit.",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "number", minimum: -1e6, maximum: 1e6 },
      from: { type: "string", enum: units },
      to: { type: "string", enum: units },
    },
    required: ["value", "from", "to"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: appUri } },
};

type Request = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
    uri?: string;
  };
};

function convert(args: Record<string, unknown> | undefined) {
  const { value, from, to } = args ?? {};
  if (
    !args ||
    Object.keys(args).length !== 3 ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e6 ||
    (from !== "celsius" && from !== "fahrenheit") ||
    (to !== "celsius" && to !== "fahrenheit")
  )
    return { isError: true, content: [{ type: "text", text: "Invalid temperature or units." }] };
  const converted =
    from === to ? value : from === "celsius" ? (value * 9) / 5 + 32 : ((value - 32) * 5) / 9;
  const result = { value: converted, unit: to };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function respond(request: Request) {
  const envelope = { jsonrpc: "2.0", id: request.id ?? null };
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { ...envelope, error: { code: -32600, message: "Invalid request" } };
  }
  if (request.id === undefined) return undefined;
  switch (request.method) {
    case "initialize":
      return {
        ...envelope,
        result: {
          protocolVersion:
            protocolVersions.find((version) => version === request.params?.protocolVersion) ??
            protocolVersions[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo,
        },
      };
    case "ping":
      return { ...envelope, result: {} };
    case "tools/list":
      return { ...envelope, result: { tools: [tool] } };
    case "tools/call":
      if (request.params?.name === tool.name) {
        return { ...envelope, result: convert(request.params.arguments) };
      }
      return { ...envelope, error: { code: -32602, message: "Unknown tool" } };
    case "resources/list":
      return { ...envelope, result: { resources: [appResource] } };
    case "resources/read":
      if (request.params?.uri === appUri) {
        return { ...envelope, result: { contents: [{ uri: appUri, mimeType, text: appHtml }] } };
      }
      return { ...envelope, error: { code: -32002, message: "Resource not found" } };
    default:
      return { ...envelope, error: { code: -32601, message: "Unknown method" } };
  }
}

export function createConverterServer() {
  return createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
      response.writeHead(415).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 4096) {
          response.writeHead(413, { Connection: "close" }).end();
          return;
        }
        chunks.push(chunk);
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = respond(
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Request)
          : {},
      );
      if (!result) response.writeHead(202).end();
      else
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch {
      response.writeHead(400).end();
    }
  });
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? "8787");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const server = createConverterServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") {
      console.log(`Unit converter listening on http://127.0.0.1:${address.port}/mcp`);
    }
  });
}
