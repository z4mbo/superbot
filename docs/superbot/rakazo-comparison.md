# Rakazo and Superbot on November 20, 2026

Superbot integrated the 200 commits between its earlier Rakazo base and upstream `9c773a5aa` in merge `0ef7e8bc3`. The comparison below uses those two immutable trees. [Rakazo source](https://github.com/elie222/rakazo/tree/9c773a5aa3e2c17fbb072ffe16bb0eabf0a070e5)

| Comparison | Result |
| --- | --- |
| Every tracked path, including assets, clients and infrastructure | 5,625 identical Git entries, 389 changed, 414 additional in Superbot and five paths exclusive to Rakazo |
| Functions and methods indexed by path and symbol | 118,079 identical, 685 changed, 4,107 keys exclusive to Superbot and 302 exclusive to Rakazo |
| API procedures exported by the shared contract | All 352 upstream procedures exist in Superbot, alongside 23 Superbot additions. Of the shared routes, 314 had identical serialized schemas and 38 differed. |
| Hosted tool definitions and model-facing parameter schemas | All 108 compared definitions are available. Three descriptions substitute the product name and the other 105 match exactly. |
| Hosted tool selection | The direct and discoverable tool sets matched for all ten sampled configurations. |

The two old Plugins overlay paths now correspond to the four-section Store and its tests. The three other paths implement and test a prompt to star Rakazo's GitHub repository. Superbot omits that promotion. A path or symbol can change when its implementation moves. The function index used the TypeScript parser for JS and TS, and Universal Ctags for supported languages. Dynamic vendor tools depend on each user's actual connections.

## What the harness gives an agent

The API queues the run. The worker assembles the bot's instructions, conversation, applicable skills and memory, and passes the selected tools to the Pi runtime. Some tools appear immediately. Others are available through `find_tool` and `use_tool`. The run origin, assigned connections, computer settings, plugin grants and approval policy determine what can execute. [Run tool selection](../../packages/adapters/src/runs/tools/run-tool-selection.ts) · [Built-in definitions](../../packages/adapters/src/tools/builtin.tool-definition.ts) · [Tool discovery](../../packages/adapters/src/tools/builtin-tool-bridge.ts)

The comparison loaded the registries on both revisions and checked tool names, descriptions, input schemas, model-facing parameters and read-only flags. It included 98 ordinary built-ins, three agent-connection tools, two discovery tools, two computer-mode definitions and three generated connector catalog tools. The ten contexts were basic and configured direct chat, a group, a helper, a scheduled run, a webhook, a messaging channel, a voice call, a new bot and a bot with explicitly disabled tools.

| Workflow | Where to use it |
| --- | --- |
| Agent instructions, GitHub issue notifications and handing work to another bot | Configure the bot's instructions, assign the GitHub connection and create its watch. The hosted worker can notify the chat and hand an issue to a chosen project bot. [Example and setup](agent-harness.md) |
| Personal and shared workspaces | Web, desktop and CLI use the selected server's Space membership. The same account and Space on two devices see the same server-side bots and conversations. [Workspace guide](workspaces.md) |
| Plugins, record apps and per-agent access | The Store supports agents, skills, plugins and connected apps. A granted hosted bot can read the owner's app records and propose an addition requiring approval. [Plugin guide](build-a-marketplace-plugin.md) |
| Agent computer | The hosted worker can use allowed terminal, browser and file operations. People can watch or control the desktop. Hardware pairing with a person's own machine uses the Electron client. [Computer guide](agent-computers.md) |
| Local model CLI chat | The `superbot` command sends the configured CLI a prompt. Its separate app-assistance flow lets the owner share bounded records and review a suggestion. Scheduled watches run on the host. [Local and hosted chat](desktop-chat-runs.md) |

## Verification

A disposable Windows-hosted PostgreSQL, API, worker and CLI fixture with two synthetic accounts exercised the GitHub issue watch and handoff, plugin grants and revocation, record reads and approved writes, local app assistance, and roster import. The GitHub and model providers were test doubles. Source coverage and tool selection do not establish a successful live login to every vendor or a separate native control for every web action.
