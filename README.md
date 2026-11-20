# Superbot

Superbot is a native Rust desktop and command-line client for shared agent workspaces. Teammates connect to the same server with separate accounts. A workspace holds its bots, conversations, files, and memberships. Community publishers can submit versioned plugins and workspace members can grant approved capabilities to individual agents.

## Run a workspace

From the checkout root, with Node and Docker Compose installed:

```sh
node infra/superbot/host.mjs init
node infra/superbot/host.mjs up
node infra/superbot/host.mjs status
```

Open the local workspace at `http://127.0.0.1:5173`, create an account and configure a model connection to run an agent. Invite teammates from Space settings. For a shared server, use an HTTPS origin reachable by every member. The hosting guide covers SMTP delivery, single-use invite links, remote signup policy, and optional Tailscale access. [Hosting and invitations](docs/superbot/hosting.md)

On Windows, you can also run the services directly with Node.js and PostgreSQL. This uses a private local database and stores instance settings outside the checkout. [Windows setup and start/stop commands](docs/superbot/windows-local.md)

## Desktop and terminal

Install Rust with rustup. On Windows, install the Visual Studio C++ desktop workload, Windows SDK and CMake tools. Run the desktop from the checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1
```

For a Windows Start menu entry and both terminal commands, use the [per-user installer](docs/superbot/windows-install.md).

Install the CLI for your user and put Cargo's `bin` directory on your PATH:

```sh
cargo install --locked --path native/cli
superbot signup
superbot list
superbot
superbot <agentname>
```

Use `superbot login` with an existing account. Set `SUPERBOT_SERVER` to your server's web origin to connect to a different deployment. The CLI keeps sessions in the operating system's credential store. [CLI commands](native/cli/README.md)

The [desktop guide](docs/superbot/desktop.md) covers the Space switcher, conversations, the community store and local UI development.

## Build a plugin

A plugin contains named skills or remote MCP tools. Each server hosts its own community registry. A publisher submits an immutable version. A deployment reviewer approves it for discovery. A member installs that version in a Space and grants individual parts to their bots. On desktop open **Plugins** in the sidebar. In the hosted web app open the account menu and choose **Integrations → Community**.

- [Build and test a marketplace plugin](docs/superbot/build-a-marketplace-plugin.md)
- [Author, review, install and grant plugins with the CLI](docs/superbot/plugin-toolkit.md)
- [Manifest and marketplace API](docs/superbot/plugin-contract.md)
- [Agent runtime integration](docs/superbot/plugin-runtime.md)
- [Example plugin](examples/plugins/marketplace-unit-converter/)

The [integration verification](docs/superbot/integration-verification.md) covers account isolation, joining a Space and the registry lifecycle against a local server.

The [landing page](superbot-site/index.html) and [plugin developer guide](superbot-site/docs/index.html) are static files. From the repository root, preview them locally after installing the web dependencies:

```sh
pnpm --dir apps/web exec vite preview --outDir ../../superbot-site --host 127.0.0.1 --port 5363
```

## Project structure

The Rust workspace under `native/` contains the GPUI desktop, command line and API clients. The server API, worker, database, provider adapters, web client and mobile apps share the same workspace contracts. [Feature coverage](docs/superbot/parity.md) · [License](LICENSE) · [Notices](NOTICE)
