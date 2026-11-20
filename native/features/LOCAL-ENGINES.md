# Local engines in Superbot

The model picker uses the CLI's model IDs. Runs use the bot's selected ID, and a missing ID fails before a prompt is sent. Restricted modes open a temporary workspace. ACP file and terminal requests are rejected and permission requests are cancelled.

| Engine | Local turn support and setup | Verification |
| --- | --- | --- |
| GitHub Copilot | Install `@github/copilot@1.0.114` and make the CLI available on PATH. On Unix, use the standalone native binary. Supply `COPILOT_GITHUB_TOKEN` to Superbot. ACP discovers models. The bounded headless invocation uses the CLI tool allowlist with no matching tool and disables built-in MCP, custom instructions, and session sync. | Official Windows binary signed-out probe and offline turn fixture. |
| Gemini CLI | Install `@google/gemini-cli@0.70.0` on PATH. Supply `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or configure Vertex using a project and explicit application credentials. ACP uses an empty native tool allowlist and disables MCP, extensions, skills and hooks. Scoped startup uses environment credentials. | Official Windows CLI signed-out probe and offline turn fixture. |
| OpenCode | Install `opencode-ai@1.19.6` on PATH on Windows or Linux. On Linux, use the standalone native binary. Supply an OpenCode, OpenAI, Anthropic or Gemini API key in the Superbot environment for that provider's models. ACP uses an isolated profile, a dedicated deny-all agent and disabled project configuration. A managed system config or macOS managed preferences can override native restrictions, so those installations are outside this mode. | Official Windows CLI probe and offline turn fixture. |
| Cursor | Install `cursor-agent` from Cursor and use `cursor-agent login` for catalog access. Windows discovery resolves the installed Node entrypoint directly. Print mode exposes shell and writes. Ask and plan modes still expose reads, and the installed CLI has no verified complete native tool allowlist. | Official Windows version, help, and isolated signed-out ACP handshake. |
| Grok | Install `grok` and use `grok login`. Version 1.0.89 uses scoped headless execution with model switching. Version 1.0.41 uses scoped ACP with the session's current model. | Existing offline fixtures. |
| Pi | Install Pi and configure a model provider in Pi. RPC runs with tools, extensions, MCP, and skills disabled. | Existing offline fixture. |
| Claude, Codex | Install and sign in through each CLI. Superbot uses its separate local drivers. | Existing local driver tests. |
| Kimi, Droid, Command Code, Kiro, Devin, Mistral Vibe, DeepSeek Harness, Qwen, Hermes, Cline, OMP | Install the vendor CLI and complete the local setup shown below for catalog access. No verified native deny-all tool profile for these integrations. | Reference driver and inventory; no installed-runtime turn coverage. |
| Custom ACP | Use `local-acp.json` with an absolute local executable and optional arguments. ACP's permission messages and client capability declarations do not confine tools that the executable implements itself. | Catalog and fail-closed fixture. |
| Antigravity, ChatGPT plan, Muse Code | Antigravity requires its managed runtime and OAuth. ChatGPT plan requires a separate OAuth and Responses transport. Muse Code requires a dedicated `muse serve` adapter and native tool controls. | Inventory only. |
| Model connections | Use the configured model connection for OpenAI, OpenAI-compatible, Anthropic, xAI, OpenRouter, Google AI Studio, Mistral, Cerebras, Groq, Greenference, ModelGo, Meta Muse, Ollama, Claude endpoints and Bedrock, or Codex endpoints. | Outside the local ACP path. |

Catalog setup and remaining turn blockers for additional CLIs:

| CLI on PATH | Local setup | Turn blocker |
| --- | --- | --- |
| `kimi` | `kimi login` | The reference ACP launch exposes an approval mode, with no verified deny-all profile. |
| `droid` | Run `droid` to configure the account. | The ACP autonomy modes govern approvals while native tools remain available. |
| `command-code` | `cmd login` | The reference Ask mode depends on approval requests and does not remove native tools. |
| `kiro-cli` | `kiro-cli login` | Disabling Autopilot leaves agent tools available. A restricted agent profile needs runtime verification. |
| `devin` | `devin auth login` | The reference driver changes approval mode through ACP. A native tool-off mode is unverified. |
| `vibe-acp` | Sign in through Vibe or set `MISTRAL_API_KEY`. | ACP exposes model and approval modes. A scoped configuration that excludes built-in and custom tools needs verification. |
| `dsh` | Set `DEEPSEEK_API_KEY`. | The ACP harness profile supports model selection. A tool-off harness profile is unverified. |
| `qwen` | Configure the Qwen CLI account or model provider. | The reference approval ladder leaves tools enabled. A scoped tool allowlist needs validation against the installed release. |
| `hermes` | `hermes setup` | The reference ACP driver uses the account's runtime configuration. A profile disabling toolsets and plugins needs validation. |
| `cline` | `cline auth` | `--auto-approve false` disables automatic approval. It does not remove native tools. |
| `omp` | `omp login` | The reference ACP launch does not pass Pi's RPC tool-off switches. OMP needs its own verified no-tools contract. |

Run offline fixtures with `cargo test -p superbot-features --lib local_acp`. With the exact official versions above on PATH, unset credentials and run `cargo test -p superbot-features --lib installed_restricted_cli_signed_out_probe -- --ignored`. The installed-CLI test opens isolated ACP sessions for startup and model discovery without sending prompts.
