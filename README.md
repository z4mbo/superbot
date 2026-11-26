# Superbot

Superbot is a desktop, web and command-line client for shared agent workspaces. Teammates connect to the same server with separate accounts. A workspace holds its bots, conversations, files, and memberships. Community publishers can submit versioned plugins and workspace members can grant approved capabilities to individual agents.

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

The desktop is the Electron app in `apps/desktop` for Windows, macOS and Linux. From the checkout, with Node.js 24.15 or newer and pnpm:

```sh
pnpm install
pnpm --filter @rakazo/desktop dev
```

The `superbot` command chats with your agents from a terminal, with a full-screen view in `superbot tui`. Build it and link it for your user:

```sh
pnpm --filter superbot-cli build
(cd apps/cli && pnpm link --global)
superbot signup
superbot list
superbot
superbot <agentname>
```

Use `superbot login` with an existing account. Set `SUPERBOT_SERVER` to your server's web origin to connect to a different deployment. The CLI keeps sessions in the operating system's credential store. [CLI commands](apps/cli/README.md)

The [desktop guide](docs/superbot/desktop.md) covers installing the desktop and terminal tools and connecting to a server. On Windows, see the [Windows install guide](docs/superbot/windows-install.md).

## Build a plugin

A plugin contains named skills or remote MCP tools. Each server hosts its own community registry. A publisher submits an immutable version. A deployment reviewer approves it for discovery. A member installs that version in a Space and grants individual parts to their bots. In the web and desktop apps, open the account menu and choose **Integrations → Community**.

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

`pnpm dev` uses the Postgres in `DATABASE_URL` when it accepts a connection. Otherwise it starts a
local `rakazo-dev-postgres` container with Docker, and every checkout reuses that one. Without
Docker, it runs a local Postgres cluster with your installed Postgres (on `PATH` or from Homebrew)
instead, also shared by every checkout. It applies
migrations and generates the Prisma client before starting. A branch that adds migrations main
doesn't have gets its own database on the same server, copied from the shared one when possible,
so unmerged schema changes stay out of it. When the default ports are taken, for example by
another git worktree, it moves to the next free block and prints the URL. Set `WEB_PORT` and
`API_PORT` to choose ports yourself.

## Project structure

The pnpm workspace holds the server API, worker, database, provider adapters, web client, Electron desktop (`apps/desktop`), mobile apps, the `superbot` command (`apps/cli`) and the `superbot-plugin` tool (`apps/plugin-kit`), which share the same workspace contracts. [Feature coverage](docs/superbot/parity.md) · [License](LICENSE) · [Notices](NOTICE)

Superbot is based on [Rakazo](https://github.com/elie222/rakazo), used under the Apache License, Version 2.0.
