# Superbot desktop

The Superbot desktop is the Electron app in `apps/desktop`, for Linux, macOS and Windows. It opens
the web app of the server it connects to, so chats, Spaces, the Store, models and settings work as
they do on the web. The [desktop app guide](../desktop-app.md) covers choosing a server, letting
bots use this computer, updates and keyboard shortcuts.

## Install

Tagged releases publish signed installers on the repository's GitHub releases page. [Desktop
releases](../desktop-release.md)

To build it from a checkout, install the workspace with pnpm and run the development app, or
package an unpacked app for this computer:

```sh
pnpm install
pnpm --filter @rakazo/desktop dev
pnpm --filter @rakazo/desktop pack:dir
```

## Connect to a server

On each device, connect to the tailnet and use the same HTTPS web origin advertised by the NixOS
host's Tailscale Serve endpoint, such as `https://superbot.example-tailnet.ts.net`. Choose
**Existing instance** in the desktop and enter that origin. See [hosting on another
machine](hosting.md#optional-private-access-with-tailscale).

## Terminal tools

The `superbot` command (with its full-screen chat, `superbot tui`) and the `superbot-plugin`
authoring tool are Node.js commands built from this repository. [Install
`superbot`](../../apps/cli/README.md#install-from-the-monorepo) · [Install
`superbot-plugin`](../../apps/plugin-kit/README.md#install-from-the-monorepo)

```sh
superbot server https://superbot.example-tailnet.ts.net
superbot login
superbot-plugin list
```

For one command, `--server URL` takes precedence over `SUPERBOT_SERVER`, and either takes
precedence over the saved address. With none of them, the commands use `http://127.0.0.1:5173`.
The saved server lives in `server.txt` under the Superbot settings directory:
`%LOCALAPPDATA%\Superbot` on Windows, `~/Library/Application Support/Superbot` on macOS, and
`$XDG_CONFIG_HOME/superbot` (default `~/.config/superbot`) on Linux.
