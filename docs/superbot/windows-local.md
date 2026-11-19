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
`http://127.0.0.1:5173` in the browser or enter the same URL in the native
client. Create your local account on the sign-up screen.

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

The Windows launcher runs with email delivery disabled. Share generated
invite links directly. For SMTP delivery, use the
[Docker hosting workflow](hosting.md) and the
[email configuration](../self-host-configuration.md).
