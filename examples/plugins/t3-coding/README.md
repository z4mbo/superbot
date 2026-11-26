# T3 Code inbox

Use Superbot to collect coding requests and start the ones you approve in T3 Code.
The [marketplace manifest](manifest.json) provides a Requests app, a Dispatches app,
and a skill for drafting requests. The command-line companion below starts a
Supervised thread using T3's official external MCP tool `t3_thread_launch`.
The receipt includes the thread link, thread ID, run ID, and status at dispatch.
Open the link in T3 to follow the run and handle approvals.

The inbox is for a person who wants to review a request and choose a specific
project, including on a private device. For bots that should launch and manage
cloud-agent runs directly from chat, use the existing authenticated
[T3 Code connector](../../../docs/self-host-integrations.md#connect-t3-code).

## Install the inbox

1. On a deployment that bundles this release, open **Discover → T3 Code inbox**
   and choose **Install**. See the [marketplace authoring guide](../../../docs/superbot/build-a-marketplace-plugin.md)
   to submit your own plugin under a separate slug. The companion expects the
   bundled manifest.
2. In the Space where you want requests, install **T3 Code inbox** from the
   marketplace. A bot that should propose requests needs the `requests` and
   `request-guide` parts. Keep `dispatches` ungranted so receipts come from the
   operator. Ask the bot to propose a coding request and approve the normal
   Superbot write card. A person can add a request in the Requests app or use
   the companion's `add` command.
3. Run the companion from a Superbot checkout with Node and the workspace
   dependencies installed. It uses the MCP SDK already pinned by Superbot.

## Sign in to T3

In T3 Settings, copy the environment's MCP URL and run:

```powershell
node examples/plugins/t3-coding/companion.mjs login --t3 'http://127.0.0.1:3773/mcp'
node examples/plugins/t3-coding/companion.mjs projects
```

Use your actual URL. The companion accepts HTTP on loopback and HTTPS for
remote environments. Open the authorization URL it prints, verify the client
name **Superbot T3 Code inbox** and the loopback callback, and approve
**Supervised** access. If T3 asks for a pairing code, create one in T3's
**Use T3 Code in another app (MCP)** flow. This is T3's public-client
authorization-code flow with PKCE. [T3 outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)

T3 stores the grant under **Settings → Sharing & access**. The companion
stores its token in `t3-auth.json` under `~/.superbot-t3-inbox`. For
`--state-dir`, use a directory only your OS account can read and write,
on a local filesystem that supports hard links. Keep the same directory for
every retry. After reconciling pending launches, revoke the old client in T3,
remove just `t3-auth.json`, and run `login` again to renew or change the grant.
Keep the saved dispatch files for receipt recovery.

## Review and dispatch a request

The companion prompts for your Superbot password and signs out the temporary
session when it exits. Use the email of the account that installed the app in
the selected Space. Password sign-in works on a private deployment without
SMTP. Pass `--email-code` to sign in by email on a deployment that sends
sign-in codes. In scripts, `--session-stdin` can read an existing signed
Superbot session from a trusted pipe.

```powershell
$inbox = 'examples/plugins/t3-coding/companion.mjs'
$account = @('--server', 'https://superbot.example.com', '--email', 'operator@example.com')
node $inbox spaces @account
node $inbox installations @account --space SPACE_ID

$scope = @($account + @('--space', 'SPACE_ID', '--installation', 'INSTALL_ID'))
node $inbox list @scope
node $inbox add @scope --title 'Add a regression test' --brief 'Cover the empty input case and run the relevant tests.'
node $inbox dispatch @scope --record REQUEST_ID --project PROJECT_ID
node $inbox receipts @scope
```

`list` and `receipts` display the newest page. For older records, pass
`--after` with the returned `nextAfter` cursor. Read the exact brief before
using its record ID in `dispatch`. Choose the destination project ID from
`projects`. The request contains only its title and brief. T3 applies the
project's default model and workspace settings, and the companion requests
Supervised mode. Each dispatch command is a separate operator approval.

If T3 accepted the launch but the reply or receipt write failed, rerun the
same dispatch command with the same local state and OAuth grant. The companion
uses the same T3 request ID and keeps the receipt locally until it can also
write it to Superbot. If the grant changed before you received the receipt,
check the destination in T3 before taking further action. A new T3 grant has
a different retry namespace. Keep pending work on one operator machine and in
one state directory.

The plugin manifest contains only Superbot data forms and bot instructions.
The companion is a local, one-shot command. It makes no background dispatches
and offers no remote command service. T3 hosts the coding experience.

## Verification

```powershell
node --test examples/plugins/t3-coding/companion.test.mjs
```

The test runs Superbot RPC and T3 MCP fixtures on fresh loopback ports with a
disposable state directory. It checks newest-first pagination, account
isolation, explicit record approval, the exact supervised launch arguments, a
lost reply after launch, and recovery from a failed receipt write. It uses
synthetic data and tokens.
