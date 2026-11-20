import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/** Whether the server rejected the request because it no longer knows the
 * session: the request never ran there, so a fresh session may replay it. */
export function isMcpSessionGoneError(error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError)) return false;
  return (
    error.code === 404 ||
    (error.code === 400 &&
      /\bBad Request: (?:Server not initialized|No valid session ID(?: provided| or initialization request)?|Mcp-Session-Id header is required)(?="|$)/i.test(
        error.message,
      ))
  );
}

/** The SDK's own wait for an answer (a tool call without progress) ran out. A cancel uses
 * the same code, but only the SDK's timers attach how long they waited. */
export function isMcpWaitTimeout(error: unknown): boolean {
  if (!(error instanceof McpError) || error.code !== ErrorCode.RequestTimeout) return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    ("timeout" in data || "maxTotalTimeout" in data || "ceiling" in data)
  );
}
