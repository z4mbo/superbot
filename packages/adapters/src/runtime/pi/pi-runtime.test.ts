import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  agentToolDefinitions,
  connectorStepNames,
  describeToolActivity,
  redactAskUserDetailInMessage,
} from "./tools/pi-runtime-tools.js";

describe("connector tool labels", () => {
  const search: ConnectorTool = {
    name: "VENDOR_SEARCH_TOOLS",
    label: "Finding tools",
    description: "",
    inputSchema: {},
  };
  const batch: ConnectorTool = {
    name: "VENDOR_MULTI_EXECUTE",
    label: "Running tools",
    description: "",
    inputSchema: {},
    batch: { items: "tools", action: "tool_slug", arguments: "arguments" },
  };
  const tools = new Map([search, batch].map((tool) => [tool.name, tool]));
  const args = { tools: [{ tool_slug: "POSTIZ_LIST_POSTS", arguments: {} }] };

  it("finds a tool under the name the model calls it", () => {
    const renamed: ConnectorTool = { ...search, name: "VENDOR SEARCH" };
    const byAgentName = agentToolDefinitions([renamed]);
    expect(describeToolActivity("VENDOR_SEARCH", {}, (name) => byAgentName.get(name))).toBe(
      "Finding tools",
    );
  });

  it("shows a label or the actions a batch runs instead of the model's tool name", () => {
    expect(describeToolActivity(search.name, { queries: [] }, (name) => tools.get(name))).toBe(
      "Finding tools",
    );
    expect(describeToolActivity(batch.name, args, (name) => tools.get(name))).toBe(
      "Using Postiz list posts",
    );
    expect(connectorStepNames(search, {})).toEqual(["Finding tools"]);
    expect(connectorStepNames(batch, args)).toEqual(["Postiz list posts"]);
    expect(connectorStepNames(batch, {})).toEqual(["Running tools"]);
    const many = { tools: ["A", "B", "C", "D"].map((tool_slug) => ({ tool_slug })) };
    expect(connectorStepNames(batch, many)).toEqual(["Running tools"]);
    const partial = { tools: [{ tool_slug: "POSTIZ_LIST_POSTS" }, {}] };
    expect(connectorStepNames(batch, partial)).toEqual(["Running tools"]);
    const odd = { tools: [{ tool_slug: "list posts --token=abc" }] };
    expect(connectorStepNames(batch, odd)).toEqual(["Running tools"]);
    expect(describeToolActivity(batch.name, odd, (name) => tools.get(name))).toBe("Running tools");
    expect(connectorStepNames(undefined, {})).toEqual([]);
  });
});

describe("describeToolActivity", () => {
  it("summarizes builtin tools with their most informative argument", () => {
    expect(describeToolActivity("shell", { command: "pnpm test --filter web" })).toBe(
      "Running: pnpm test --filter web",
    );
    expect(describeToolActivity("read_file", { path: "notes/plan.md" })).toBe(
      "Reading notes/plan.md",
    );
    expect(describeToolActivity("write_file", { path: "out.csv", content: "…" })).toBe(
      "Writing out.csv",
    );
    expect(describeToolActivity("edit_file", { path: "src/app.ts", patch: "…" })).toBe(
      "Editing src/app.ts",
    );
    expect(describeToolActivity("search_files", { pattern: "TODO" })).toBe("Searching files: TODO");
    expect(describeToolActivity("glob", { pattern: "**/*.md" })).toBe("Finding files: **/*.md");
    expect(describeToolActivity("process_manage", { action: "start", command: "pnpm dev" })).toBe(
      "Starting in the background: pnpm dev",
    );
    expect(describeToolActivity("process_manage", { action: "check", id: "abc" })).toBe(
      "Checking background processes",
    );
    expect(describeToolActivity("process_manage", { action: "kill", id: "abc" })).toBe(
      "Stopping a background process",
    );
    expect(describeToolActivity("browser_cdp", { method: "DOM.getDocument" })).toBe(
      "Inspecting the page: DOM.getDocument",
    );
    expect(describeToolActivity("browser_dialog", { action: "accept" })).toBe(
      "Accepting a page dialog",
    );
    expect(describeToolActivity("browser_dialog", { action: "dismiss" })).toBe(
      "Dismissing a page dialog",
    );
    expect(describeToolActivity("list_fleet", {})).toBe("Checking your bots");
    expect(describeToolActivity("delegate", { brief: "Shortlist venues\nfor 40" })).toBe(
      "Starting a task: Shortlist venues",
    );
    expect(describeToolActivity("delegate", { brief: "…", title: "Venue shortlist" })).toBe(
      "Starting a task: Venue shortlist",
    );
    expect(describeToolActivity("follow_up", { threadId: "t" })).toBe("Following up on a task");
    expect(describeToolActivity("stop_task", { threadId: "t" })).toBe("Stopping a task");
    expect(describeToolActivity("link_to_thread", {})).toBe("Finding a task");
    expect(describeToolActivity("offer_check_in", { subject: "Launch brief" })).toBe(
      "Offering a check-in: Launch brief",
    );
    expect(describeToolActivity("render_plot", { spec: {} })).toBe("Rendering a chart");
    expect(describeToolActivity("save_page", { help: true })).toBe(
      "Reading the page kit reference",
    );
    expect(describeToolActivity("save_page", { title: "Plan", source: "x" })).toBe(
      "Writing the page code",
    );
    expect(describeToolActivity("add_mcp_server", { name: "Linear" })).toBe(
      "Connecting MCP server: Linear",
    );
    expect(describeToolActivity("remove_mcp_server", { name: "Linear" })).toBe(
      "Removing MCP server: Linear",
    );
    expect(describeToolActivity("delete_shared_memory", { path: "team.md" })).toBe(
      "Deleting shared memory: team.md",
    );
    expect(describeToolActivity("run_subagent", { name: "scout", task: "…" })).toBe(
      "Delegating to helper: scout",
    );
    expect(describeToolActivity("create_space", { name: "Customer support" })).toBe(
      "Creating space: Customer support",
    );
    expect(describeToolActivity("web_search", { query: "rakazo agents" })).toBe(
      "Searching the web: rakazo agents",
    );
    expect(describeToolActivity("web_fetch", { url: "https://example.com" })).toBe(
      "Reading page: https://example.com/",
    );
  });

  it("names MCP server and remote tool", () => {
    expect(describeToolActivity("mcp__brex__list_expenses", {})).toBe("Using brex: list_expenses");
    expect(describeToolActivity("mcp__demo-oauth__greet", {})).toBe("Using demo-oauth: greet");
  });

  it("truncates long details and collapses whitespace", () => {
    const long = `x${"y".repeat(200)}`;
    const line = describeToolActivity("shell", { command: `a\n\t${long}` });
    expect(line.length).toBeLessThanOrEqual("Running: ".length + 91);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/^Running: a x/);
  });

  it("redacts credentials from activity details", () => {
    const token = "fake-token";
    const line = describeToolActivity("shell", {
      command: `curl -H 'Authorization: Bearer ${token}' https://example.test?api_key=fake-key password=fake-password`,
    });

    expect(line).toContain("Bearer [redacted]");
    expect(line).toContain("api_key=[redacted]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("fake-key");
    expect(line).not.toContain("fake-password");
  });

  it("strips signed-URL query and fragment from web_fetch activity", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@cdn.example.test/doc.pdf?X-Amz-Signature=abc123&token=leak#frag",
    });
    expect(line).toBe("Reading page: https://cdn.example.test/doc.pdf");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("does not echo secrets from malformed web_fetch URLs", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@[",
    });
    expect(line).toBe("Reading page: [invalid URL]");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("user:");
  });

  it("names the image or video an understanding tool reads, never a signed URL's query", () => {
    expect(describeToolActivity("vision_analyze", { path: "shots/receipt.png" })).toBe(
      "Looking at image: shots/receipt.png",
    );
    expect(describeToolActivity("vision_analyze", { attachment: "attachments/abc.jpg" })).toBe(
      "Looking at image: attachments/abc.jpg",
    );
    const line = describeToolActivity("video_analyze", {
      url: "https://cdn.example.test/clip.mp4?X-Amz-Signature=abc123",
    });
    expect(line).toBe("Watching video: https://cdn.example.test/clip.mp4");
    expect(describeToolActivity("video_analyze", {})).toBe("Watching video");
  });

  it("falls back to the tool name", () => {
    expect(describeToolActivity("destination_write", undefined)).toBe("Using destination_write");
  });
});

describe("redactAskUserDetailInMessage", () => {
  it("leaves malformed ask_user arguments for argument preparation to reject", () => {
    const content = [
      { type: "toolCall", name: "ask_user", arguments: "detail" },
      { type: "toolCall", name: "ask_user", arguments: 7 },
      { type: "toolCall", name: "use_tool", arguments: { name: "ask_user", arguments: "detail" } },
      { type: "toolCall", name: "ask_user", arguments: { detail: "token sk-test-1" } },
    ];
    expect(() =>
      redactAskUserDetailInMessage({ role: "assistant", content }, ["sk-test-1"]),
    ).not.toThrow();
    expect(content.map((part) => part.arguments)).toEqual([
      "detail",
      7,
      { name: "ask_user", arguments: "detail" },
      { detail: "token [redacted]" },
    ]);
  });

  it("redacts secrets in ask_user arguments a use_tool wrapper carries as a bare string", () => {
    const content = [
      {
        type: "toolCall",
        name: "use_tool",
        arguments: { name: "ask_user", arguments: "send sk-test-1?" },
      },
    ];
    redactAskUserDetailInMessage({ role: "assistant", content }, ["sk-test-1"]);
    expect(content.map((part) => part.arguments)).toEqual([
      { name: "ask_user", arguments: "send [redacted]?" },
    ]);
  });
});
