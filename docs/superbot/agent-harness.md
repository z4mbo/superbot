# Agent instructions, tools and handoff

## How a chat runs

For a server model, the API saves a message and queues a run. The worker builds the model's context from the selected thread, the bot's saved working instructions, relevant memory and skills. Its Pi runtime (`@earendil-works/pi-agent-core` and `pi-ai`) handles the model and tool loop. A tool result goes back to the model so it can finish the turn. The server publishes progress and saves the reply for the clients in the Space.

The worker selects tools for the bot, the account and the run's origin. Depending on those settings a bot can search the web, use its computer's browser, terminal and files, read a skill, use a connected service or message another bot. Some tools are discovered during the turn. Authorization and approval also apply when a tool executes. A bot's instructions describe the job. Access comes from the installation, grants, connector credentials and Space rules.

On a self-hosted server with one active account and no model usage billing, the operator can use a model CLI installed and signed in on the server as the deployment model. An MCP server lists the worker's tools without executing them. The CLI returns tool calls to Superbot, and the worker handles them, including agent computer calls, with the same authorization and approvals.

For a model CLI selected for `superbot` on this device, the command builds a prompt with the current bot instructions and recent text from the open conversation. The CLI returns text and Superbot saves the exchange to the server. A local chat has no shell, browser or MCP tools. The separate `/apps` flow can show the owner a granted record app and ask them to confirm a proposed addition. A server worker runs background watches while the command is closed. [Hosted and local chat runs](desktop-chat-runs.md)

## Watch GitHub issues and choose an agent

1. Open **Store → Agents → GitHub issue watcher** and add it. To try a community copy, open **Import an agent** on the web and import the [shareable Markdown example](../../examples/agents/github-issue-watch.md). Review the instructions before creating it. You can edit them later in the bot's **Instructions**. Both paths leave the repository, connection and routine for you to choose.
2. In **Store → Apps → GitHub**, connect a credential with **Issues: read** on the chosen repository. In the connection's agent settings, select the watcher. For an installed community plugin, choose the agent and the specific parts on the plugin page. Repeating a grant for a development bot is a separate choice. [GitHub MCP server](https://github.com/github/github-mcp-server)
3. With a server model configured, open the bot's **Routines** in the web workspace. Create an active routine with **When something changes → An integration tool**. Use the name exposed by your connection, normally `mcp__github__list_issues` for the direct GitHub preset. Enter `number` in **Fields to compare**, leave quiet checks silent and set the interval (15 minutes by default, 5 minutes minimum). In the prompt, name the repository and say “Send me the link to each newly created issue. Wait for me to choose an assignee.” Configure these arguments with your owner and repo:

   ```json
   {
     "owner": "example",
     "repo": "project",
     "orderBy": "CREATED_AT",
     "direction": "DESC",
     "perPage": 100,
     "fields": ["number"]
   }
   ```

   The connector returns both open and closed issues. The first read establishes the baseline. Changing a title or closing a listed issue keeps its number, so that alone leaves the watcher quiet. A change to the list wakes the worker, which can look up the issue and report in chat. Revoking the assignment prevents the next read. This works over outbound HTTPS on a Tailscale-only host. Polling samples the latest 100 issues. A burst larger than one page between two checks can hide older arrivals. [GitHub issue-list parameters](https://github.com/github/github-mcp-server/blob/main/pkg/github/issues.go)
4. Turn on the agent's **Notifications** for completion alerts. Device notifications also require the client's notification permission. When the watcher reports `example/project#42`, you can open it yourself, leave it for later, or reply “Ask the development agent to prepare a plan for #42.” In a direct chat the worker uses `message_bot` to send the brief to the selected bot in the Space. Its result can return to the watcher. A group conversation can also hand the turn to a group member.

For a server with a public webhook endpoint, an inbound alternative avoids polling. Add a **Git event** routine on the watcher. In the chosen repository, configure a GitHub webhook for **Issues** with the bot's secret. Append `/issues/opened` to the supplied URL ending in `/github` to wake it on opened issues only. Delivery uses GitHub's signature, includes the repository ID and issue number, and deduplicates retries. The generic URL continues to accept other Git events. [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues)

## Sharing an agent

The Store's Agents catalog contains reviewed built-in templates. A community author can share an agent document directly. People import it into their own Space, inspect its instructions and choose connections and plugin grants. The plugin registry publishes skills, tools and record apps. Publishing an agent to the built-in Agents catalog is currently a source change.

## Other chat harnesses

| Product | Execution and tools |
| --- | --- |
| OpenBot (Nightly Labs) | Local-first teammates with a dedicated workspace, task queues, browser control and agent-to-agent collaboration. It uses Codex App Server and Claude Code directly, and supports other CLIs through ACP. In the default Full access mode, agents can access files, run commands and control the browser without per-action approval after initial consent. [Project README](https://github.com/nightly-labs/openbot/blob/740efbb4dd4a2ee8740e5429dbe8b74e184a1be8/README.md#L16-L19) |
| OpenMausBot | Local drivers adapt Claude's stream-JSON, Codex's JSON-RPC and Grok's ACP into shared chat events. Its permission broker routes shell and file approvals. Bot computers and connected apps extend the available tools. [Architecture](https://github.com/milind-soni/OpenMausBot#how-it-works) |
| Rakazo | Its server worker owns runs and exposes approved tools to a Pi agent. Superbot reuses this worker and tool system for server runs. [Upstream runtime](https://github.com/elie222/rakazo/blob/main/packages/adapters/src/runtime/pi/pi-runtime.ts) |
| Grok Bot | The inspected Windows app packages an Electron client, local execution and a node coordinator. The vendor says the service automatically selects a backend model for each task, with no model picker, and that bots can work on a cloud computer. [Installed build evidence](parity.md) · [Vendor FAQ](https://docs.x.ai/grok-bot/faq#can-i-pick-the-model) · [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works) |
