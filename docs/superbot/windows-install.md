# Install Superbot on Windows

Install the desktop app from the installer on the repository's GitHub releases page. To build it
from a checkout instead, install Node.js 24.15 or newer and pnpm, then run from the checkout root:

```powershell
pnpm install
pnpm --filter @rakazo/desktop pack:dir
```

The unpacked app is written to `apps/desktop/out`. `pnpm --filter @rakazo/desktop dev` builds and
opens the development app instead. [Desktop guide](desktop.md)

The `superbot` and `superbot-plugin` commands are Node.js commands built from the same checkout.
Follow [Install `superbot`](../../apps/cli/README.md#install-from-the-monorepo) and [Install
`superbot-plugin`](../../apps/plugin-kit/README.md#install-from-the-monorepo), then open a new
terminal and run `superbot --help` or `superbot-plugin --help`. Account sessions are kept in
Windows Credential Manager.

Start your [local Superbot server](windows-local.md) before connecting, or sign in to a [hosted
server](hosting.md).
