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

## Built-in tools

Built-in tools come from the catalog in `packages/contracts/src/bots/builtin-tools.ts`. A small core set is always listed to the model; the rest are found during the turn with `find_tool` and called with `use_tool`. Which tools a run is offered depends on the bot, the account and where the run started. Tools marked *asks first* wait for the person's approval in the chat before they change or delete anything.

### Files

| Tool | What it does |
| --- | --- |
| `list_files` | Lists files and folders in the bot's home on its computer. |
| `read_file` | Reads a text file from the bot's home, in line ranges for long files. |
| `write_file` | Writes a text file into the bot's home. |
| `edit_file` | Changes part of a text file in the bot's home: replaces an exact string, or applies a unified diff. Refuses binary files and paths outside the home. |
| `search_files` | Searches file contents in the bot's home with a regular expression and returns file, line and the matching line. Uses ripgrep when the computer has it, else grep. |
| `glob` | Finds files in the bot's home whose path matches a pattern such as `**/*.ts`. |
| `attach_file` | Attaches a file from the bot's home to the chat. |

### Terminal

| Tool | What it does |
| --- | --- |
| `shell` | Runs a command on the bot's computer. |
| `process_manage` | Starts a long-running command, such as a dev server, in the background, then lists, checks and stops it, also from later runs. Starting is gated as `shell` is; stopping asks first. Only processes it started can be checked or stopped. |

### Code and plots

| Tool | What it does |
| --- | --- |
| `render_plot` | Renders a chart from tabular data as an image in the chat. |

### Browser and screen

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Opens a URL in the page browser on the bot's computer. |
| `browser_snapshot` | Reads the current page as numbered elements. |
| `browser_act` | Clicks or fills page elements from a snapshot. |
| `computer_observe` | Captures the bot computer's screen. |
| `computer_act` | Runs a short batch of mouse and keyboard actions on the bot's computer. |
| `sign_in` | Fills a login in the page browser from the person's password manager, which approves each login itself. |

### Web

| Tool | What it does |
| --- | --- |
| `web_search` | Searches the public web. |
| `web_fetch` | Reads a public page as text. |
| `exa_search` | Searches the web with Exa, with domain and date filters and page excerpts or text. Offered only once the person saved an Exa key in Settings. |
| `firecrawl_scrape` | Reads a public page as markdown with Firecrawl, including pages that need JavaScript. Offered only once the person saved a Firecrawl key in Settings. |
| `service_search` | Finds a paid data service and its price per call. |
| `service_call` | Calls a paid data service. Asks first. |

### Media

The `generate_` tools make new media with a media provider; the `_analyze` tools only read existing media with a connected chat model.

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates an image and attaches it to the chat. Asks first. |
| `generate_video` | Generates a short video and attaches it when ready. Asks first. |
| `vision_analyze` | Describes one image from the workspace, a chat attachment or a public https URL and answers a question about it, as text. Uses the bot's own model when it reads images, otherwise the person's computer-use model. Offered only when one of them reads images. A URL on a site the run was not given is gated as `web_fetch` is. |
| `video_analyze` | Does the same for one video. Offered only when a connected model reads video; no supported model is marked as reading video yet, so it is not offered today. |

### Memory

| Tool | What it does |
| --- | --- |
| `remember` | Saves a short fact to the bot's own memory, a person's profile or today's note. |
| `save_shared_memory` | Saves a Space shared memory document every bot reads. |
| `delete_shared_memory` | Deletes a Space shared memory document. `MEMORY.md` is kept. Asks first. |
| `save_memory` | Stores a fact in the connected memory provider. |
| `recall_memory` | Searches the memory provider by meaning. |
| `forget_memory` | Forgets one fact in the memory provider. Asks first. |
| `reflect_memory` | Answers a question from the memory provider. |
| `search_history` | Searches earlier messages by keyword. |
| `read_history` | Reads around an earlier message. |

### Connections

| Tool | What it does |
| --- | --- |
| `connect_app` | Shows a card in the chat to connect an app. |
| `add_mcp_server` | Adds a remote MCP server the person described; its tools arrive once they approve the card. |
| `remove_mcp_server` | Removes one of the person's remote MCP servers and its saved credentials. Local servers stay in Settings. Asks first. |

### Bots and task threads

| Tool | What it does |
| --- | --- |
| `run_subagent` | Hands a task to a helper whose result comes back later. |
| `delegate` | Starts a task in a thread of its own the person can open, linked to the conversation that started it, and returns at once. The task's result comes back to that conversation. Only that conversation can follow the task up, stop it or list it, and a task thread starts no task threads of its own. |
| `follow_up` | Reads where one of the conversation's tasks stands (its status and latest report), or sends it more work once its last run has ended. |
| `stop_task` | Stops one of the conversation's tasks, as Stop in that thread does. Asks first. Named `stop_task` rather than `stop`, which reads as the chat's own Stop. |
| `link_to_thread` | Lists the conversation's tasks with their status and a link that opens each thread. |
| `message_bot` | Sends a message to another bot in the Space. |
| `handoff_to_bot` | Passes the next stage of the work to another group member. |
| `post_to_group` | Posts in one of the bot's groups without waking anyone. |
| `spawn_bot` | Creates a regular bot with its own thread, computer and memory. |

### Schedules

| Tool | What it does |
| --- | --- |
| `schedule_create` | Creates a reminder or recurring job for the bot. |
| `schedule_list` | Lists the bot's routines. |
| `schedule_update` | Changes one routine in place. |
| `schedule_cancel` | Cancels a routine. |
| `offer_check_in` | Offers the person a check-in as a card they set up or turn down. Nothing is scheduled unless they accept; accepting creates the routine as `schedule_create` does, and **Never ask** never accepts for them. |

### Other areas

| Area | What it does |
| --- | --- |
| Secrets | `request_secret`, `generate_secret`, `list_secrets`, `secret_request`, `forget_secret`: collect, create and use saved credentials the bot never sees; using or removing one asks first. |
| Email | `read_email`, `send_email`, `delete_email`, `claim_email_address`: the bot's own inbox and address; sending, deleting and claiming ask first. |
| Calendar and reminders | `list_calendars`, `list_calendar_events`, `create_calendar_event`, `list_reminders`, `create_reminder`, `complete_reminder`, `read_meeting_transcript`: calendars, phone reminders and meeting transcripts; changes ask first. |
| Tasks and tickets | `task_catalog`, `scratchpad_list`, `scratchpad_add`, `scratchpad_update`, `scratchpad_complete`, `scratchpad_remove`, `board_tickets`, `ticket_get`, `ticket_create`, `ticket_update`, `ticket_comment`: the bot's open work and the ticket board. |
| Skills | `skill_read`, `skill_create`, `skill_update`, `skill_delete`: reusable how-to recipes. |
| Apps and pages | `save_page`, `read_app_state`, `run_app_action`, `find_apps`, `open_app`: pages and installed apps the person opens from the chat. |
| Purchases | `request_purchase`, `purchase_status`, `paid_request`: buying with the person's wallet, which approves each purchase itself. |
| Calls | `call_user`, `end_call`: voice calls with the person. |
| Fleet | `update_bot`, `list_fleet`, `create_group`, `update_group`, `organize_bot`, `set_child_instructions`, `set_child_bot_model`, `create_child_routine`, `archive_bot`, `create_space`: the bot's own settings and the person's other bots, groups and spaces; instruction and model changes, archiving and new spaces ask first. |
| Cloud agents | `cloud_agent_launch`, `cloud_agent_status`, `cloud_agent_reply`, `cloud_agent_cancel`: remote coding agents on a connected repository; all but status ask first. |
| The person's computer | `user_computer_list`, `user_computer_shell`, `user_computer_observe`, `user_computer_act`, `open_path`, `launch_app`, `request_takeover`: the person's own computer, which asks first, and graphical apps on the bot's computer. |
| Preferences and feedback | `ask_user`, `message_user`, `update_preferences`, `feedback`: questions and updates to the person, their account preferences, and reports to the server's operators; feedback asks first. |
| Agent connections | `connect_agent`, `respond_agent_connection`, `message_agent`: standing connections to another person's agent; answering a request asks first. |

## Other chat harnesses

| Product | Execution and tools |
| --- | --- |
| OpenBot (Nightly Labs) | Local-first teammates with a dedicated workspace, task queues, browser control and agent-to-agent collaboration. It uses Codex App Server and Claude Code directly, and supports other CLIs through ACP. In the default Full access mode, agents can access files, run commands and control the browser without per-action approval after initial consent. [Project README](https://github.com/nightly-labs/openbot/blob/740efbb4dd4a2ee8740e5429dbe8b74e184a1be8/README.md#L16-L19) |
| OpenMausBot | Local drivers adapt Claude's stream-JSON, Codex's JSON-RPC and Grok's ACP into shared chat events. Its permission broker routes shell and file approvals. Bot computers and connected apps extend the available tools. [Architecture](https://github.com/milind-soni/OpenMausBot#how-it-works) |
| Rakazo | Its server worker owns runs and exposes approved tools to a Pi agent. Superbot reuses this worker and tool system for server runs. [Upstream runtime](https://github.com/elie222/rakazo/blob/main/packages/adapters/src/runtime/pi/pi-runtime.ts) |
| Grok Bot | The inspected Windows app packages an Electron client, local execution and a node coordinator. The vendor says the service automatically selects a backend model for each task, with no model picker, and that bots can work on a cloud computer. [Installed build evidence](parity.md) · [Vendor FAQ](https://docs.x.ai/grok-bot/faq#can-i-pick-the-model) · [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works) |
