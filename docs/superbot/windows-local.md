# Run Superbot locally on Windows

Use Node.js and pnpm as declared in `package.json`, and a PostgreSQL installation
that provides `postgres.exe`, `initdb.exe`, and `pg_ctl.exe`. If the PostgreSQL
`bin` directory is on `PATH`, the script finds it. Otherwise, pass its full path
with `-PostgresBin` on the first start. PostgreSQL 18.7 Windows binaries were
used for verification.

From the checkout root, install dependencies and start the instance.

```powershell
pnpm.cmd install --frozen-lockfile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/superbot/windows-local.ps1 start
```

`-ExecutionPolicy Bypass` applies to this PowerShell invocation. Open
`http://127.0.0.1:5173` in the browser or enter the same URL as an **Existing
instance** in the desktop app. Create your local account on the sign-up screen.

The web, API and database listen on `127.0.0.1` on ports `5173`, `3173`,
and `55439`. If a port is busy on first start, choose a free port with
`-WebPort`, `-ApiPort`, or `-DatabasePort`. The first start records the ports
and PostgreSQL binary directory. Use a clean checkout without development
`.env` files in the repository root, `apps/web`, or `packages/db` so the
services use the settings provided by the launcher.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/superbot/windows-local.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/superbot/windows-local.ps1 stop
```

The services run in the background for the current Windows session. Start
the instance again after signing in or rebooting. Repeating `start` while
it is healthy reuses the running processes. If `status` shows only some
services running, use `stop` and then `start` to restart the stack.

`%LOCALAPPDATA%\Superbot\local` holds the private instance settings, generated
credentials, database, app files and logs. Keep this directory private.
`stop` preserves it. Inspect `logs` in that directory for startup errors
and back up the directory while the stack is stopped to preserve a local
installation.

## Enable a marketplace reviewer

Stop the stack and add a `reviewerEmails` array to the existing object in
`%LOCALAPPDATA%\Superbot\local\settings.json`. List only the accounts you
want to grant deployment-wide marketplace review access. Start the stack again
to apply the allowlist. A listed email must also be verified.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/superbot/windows-local.ps1 bootstrap-reviewer -ReviewerEmail reviewer@example.test
```

Enter a password of at least 16 characters at the hidden prompt. For an
existing unverified account, enter its current password. For a new account,
use the password you want to sign in with. Superbot verifies the specified
account and creates its personal Space if one is needed.

## Connect a local model server

Private endpoints are disabled by default. To connect an OpenAI-compatible
model server on this computer or a private network, stop Superbot, set
`"allowPrivateEndpoints": true` in the existing `settings.json` object, and
start it again. Enter the endpoint's base URL and any credentials in model
connection settings. For a server on this computer, a base URL might be
`http://127.0.0.1:11434/v1`. Use HTTPS when sending an API key or custom
headers.

This sets Superbot's `MCP_ALLOW_PRIVATE_ENDPOINT` policy on the API and worker
for every account on this instance. It also allows private destinations for
configured remote MCP, API and GraphQL connectors and compatible speech
servers. Enable it only on an instance whose users you trust with this
network access. Community marketplace connectors still require public HTTPS
destinations.

## Send invite emails with SMTP

With the default settings, share generated invite links directly. To enable
email delivery, stop Superbot and create
`%LOCALAPPDATA%\Superbot\local\smtp.json` with your relay settings.

```json
{
  "SMTP_URL": "smtps://account:percent-encoded-password@smtp.example.com:465",
  "EMAIL_FROM": "Superbot <superbot@example.com>"
}
```

Use a sender the relay allows and URL-encode credentials. Use `smtp://` with
the relay's submission port for STARTTLS, or `smtps://` for implicit TLS. The
launcher selects `EMAIL_PROVIDER=smtp` when this file exists. You may also set
`EMAIL_REPLY_TO`. For a relay signed by a private CA, the optional
`NODE_EXTRA_CA_CERTS` field takes an absolute path to a PEM file. Use a CA
you trust for the API and worker because this expands Node's TLS trust for
both services. Use doubled backslashes or forward slashes in JSON paths.

Keep `smtp.json` private. Start Superbot again and verify the Space owner's
email address before using **Send invite** under **Manage workspace → People**.
The relay also sends account mail, including verification links. To disable
mail, remove or move `smtp.json` while the stack is stopped.
[Email configuration](../self-host-configuration.md)
