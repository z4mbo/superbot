# Where agent computers run

An agent's computer runs in one of three places. The server decides which, from its own
configuration and, where it allows a choice, from Settings. No client can make a computer run
somewhere the server does not offer.

| Path                    | Where it runs                                                              | Who sets it up                                                                                                                     | What the person sees                                                                                    |
| ----------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Server-hosted Docker    | A Linux container on the server's own Docker host, through its supervisor | The server's operator: `SANDBOX_PROVIDER=docker` with a supervisor token ([hosting](hosting.md#enable-isolated-agent-computers)) | Start, stop, **Watch**, files                                                                           |
| On the person's machine | The computer the Electron desktop app is installed on                      | The person, in the Electron app, after its native consent prompt                                                                   | "Works on your computer". There is no remote screen                                                     |
| Cloud                   | A managed remote desktop from a provider such as Boat or Boxd              | An administrator in Settings, or the environment ([sandbox providers](../self-host-sandbox-providers.md#remote-providers))          | The same as Docker: start, stop, **Watch**, files. Screens reach the app only through the server's proxy |

Hosting the server on a remote machine, such as a NixOS host running Docker computers, is the
server-hosted path. It does not give agents the machine the app runs on.

## Choosing where computers run

Choosing is open when the server sets `COMPUTER_SETTINGS_ENABLED=true` and its own provider can
route by Settings. Docker can; the person's-machine and test providers cannot.

In **Settings → Computers**, **New computers run on** picks where computers run. An
administrator chooses for the whole deployment, and for their own computers under **My
computers**. Anyone else sees the choice when the server lets accounts choose, and chooses for
their own computers. **Default** keeps the
server's own provider. Choosing a cloud provider shows the settings that provider asks for. A
saved key is never shown again, and leaving it blank keeps it. The server checks the settings
before it keeps them and answers "Could not verify computer settings" when they do not pass.
Going back to **Default** removes the saved keys. Running computers move the next time they
start.

The row does not appear when the server offers no choice, when it runs no computers, or when the
computer is the person's own machine.

## The person's own machine

Only the Electron desktop app can lend its computer. On sign-in it pairs with the server through
`/api/devices/pair` and keeps the device token in app-private storage. Every request from the
server then waits for that computer's consent, which only the app's native prompt gives.

- **Pair with a remote server:** sign in to it in the Electron app. The app pairs on its own, and
  nothing runs until the person answers the app's native prompt for that server.
- **Pair with an app-managed local instance:** choose **Use this computer** (**Use this Mac** on
  macOS) when the app asks. **Computer Access…** in the app menu changes the choice.
- **Revoke:** for a local instance, **Revoke Local Computer Access** in the app menu disconnects
  active operations and forgets the permission. For a remote server, signing out of the app ends
  the pairing. The server's `DELETE /api/devices/:deviceId` revokes a device for its owner's
  session, but no client lists devices yet.

## Terminal

When a running computer's provider reports a terminal (`terminalAvailable`), the server offers a
shell in the agent's working folder through its screen proxy, the same path as **Watch**.
`computer.terminalUrl` with `nativeSession` returns the address and a socket proof. It gives them
only to a signed-in session that holds control. The proxy then checks that session,
the member's place in the Space and the control lease on every connection. Handing back control
ends the shell, and its proof no longer opens a socket. The frames follow
`packages/contracts/src/computers/terminal.ts`.

The apps have no terminal view. A person who takes control in **Watch** can open the computer's
own terminal on its desktop.

## Checking it without keys or credits

The [isolated chat fixture](chat-verification.md) runs on `SANDBOX_PROVIDER=fake`, which keeps the choice
closed. To see the choice, run a copy of it with `SANDBOX_PROVIDER=docker`,
`COMPUTER_SETTINGS_ENABLED=true`, `RAKAZO_ADMIN_EMAILS` naming the owner, and
`SANDBOX_SUPERVISOR_URL` pointing at an unused loopback port. Mark the owner's email verified in
the fixture database, since administrators must have one. Choose a cloud provider with a
placeholder key, save, and go back to **Default**. Saving a provider without its own connection
check, as Boat and Boxd are, contacts nobody, and nothing provisions until a computer starts.
