# Hosted and local chat runs

The model chosen for the bot determines where a turn runs. The server worker can use a model
connection or a model CLI installed on the server. The `superbot` command can also run a model
CLI installed on this device, when a local model is selected for the agent on this device.

| | Hosted model | Model CLI on this computer |
| --- | --- | --- |
| Where it runs | The server's run worker, using a model connection or the deployment model | `superbot` starts the CLI on this device |
| Who can choose it | Any member who can change the bot. The server operator configures the deployment model | The member on this device. The choice is stored per device, server, account and Space, in `local-models/` under the Superbot settings directory |
| Sending | `threads/send` | The CLI runs first; the exchange is then saved to the shared thread. If saving fails, `/retry` saves it without running the model again |
| Reply | Streams over `threads/subscribe` | Arrives whole |
| Tools and approvals | Server tools, the agent's computer and granted plugins. Question and approval cards are answered with `threads/answer` | None. Claude Code runs with `--tools ""` and an empty MCP config, Codex with a read-only sandbox and its shell, browser and computer tools off, and ACP engines get no file system, terminal or MCP, with every permission request refused |
| Context | The bot's saved instructions, server thread, memory, skills and granted plugins | The bot's current saved instructions and the last 40 text messages from this conversation. Local chat accepts text |
| App records | Through granted plugins, approved per call | `/apps` sends one app's recent records to the model. A suggested record is added only after `save` |

Nothing in Superbot writes the per-agent local model selection today: a selection saved on this
device earlier keeps working, and without one the agent uses its hosted model. [`superbot`
chat](../../apps/cli/README.md#chat)

When the operator configures a CLI installed and signed in on the server as the deployment
model, an MCP server lists the worker's tools without executing them. The CLI returns tool
calls to Superbot and the worker handles them with its usual authorization and approvals.
This option is for a self-hosted server with one active account and no model usage billing.
[Deployment requirements](../self-host-models.md#claude-code-cli)

## The agent's computer

For a working example of a bot with its own instructions and connector, see [Watch GitHub issues and choose an agent](agent-harness.md).

Only hosted runs use the agent's computer. The run worker gives the model its computer
tools (screen, input, shell, files, apps and a browser) and runs each call on the computer
provisioned for that bot, through the computer provider the Space chose. Space approval
rules can refuse these calls, and payments or saved logins always ask. The provider decides
where the computer lives. Every provider a production server uses is isolated from the
server. The one kind that runs on the host machine itself is refused unless the server
runs inside the desktop app or in development.

A model CLI on the server can request these tools through the worker. A turn from a model
CLI on this device runs as a single prompt and saves its reply to the thread. It starts
no server run, so it has no access to the agent's computer.
