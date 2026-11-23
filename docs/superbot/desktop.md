# Superbot desktop

Superbot uses Rust and GPUI on Windows, macOS and Linux. The desktop also opens the hosted web client in an app window.

## Install from source

On macOS, install Rust with rustup and select a full Xcode installation with the Metal toolchain. On Apple silicon, use the native ARM64 Rust toolchain for an ARM64 build. From the repository root, run:

```sh
bash scripts/install-native-macos.sh
export PATH="$HOME/.local/bin:$PATH"
open "$HOME/Applications/Superbot.app"
```

The installer builds for the Mac's Rust host architecture and puts both commands in the app bundle, with links in `~/.local/bin`. Add the `export` line to your shell profile to keep `superbot` and `superbot-plugin` on your `PATH`. This is a local source build without a Developer ID signature or notarization. Quit Superbot before reinstalling it.

At launch, Superbot checks the macOS login keychain for its saved server session. If macOS asks to unlock it, enter the keychain password in the system dialog. It usually matches your Mac user password, and can still be the previous one after a password reset. You can cancel and use the web workspace in Safari with your Superbot account. Resetting the default keychain deletes its saved passwords. [Apple's login keychain guide](https://support.apple.com/guide/keychain-access/kyca2429/mac)

On Windows, run the existing launcher from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1
```

To install the Windows app and both commands, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-native.ps1 -StartMenuShortcut`. See [Windows server setup](windows-local.md) for local development.

On a Linux desktop, build and install with `bash scripts/install-native-linux.sh` from the repository root. The installer registers **Superbot** in the desktop application menu and places `superbot`, `superbot-plugin` and `superbot-desktop` in `~/.local/bin`. A terminal-only machine can use `bash scripts/install-native-linux.sh --cli-only`. Account sign-in uses the Linux Secret Service in the user's D-Bus session. Add `~/.local/bin` to your shell's `PATH` to use the commands.

## Connect to a server

On each client device, connect to the tailnet and use the same HTTPS web origin advertised by the NixOS host's Tailscale Serve endpoint. Use the origin alone, such as `https://superbot.example-tailnet.ts.net`. See [hosting on another machine](hosting.md#optional-private-access-with-tailscale).

Enter that address in **Server** on the desktop sign-in screen, or set it before launching any of the clients:

```sh
superbot server https://superbot.example-tailnet.ts.net
superbot login
superbot-plugin list
```

The desktop saves the address you choose on the sign-in form when you submit valid fields. An origin supplied through `SUPERBOT_SERVER` applies to that launch only. Editing the field to a different origin saves your new choice. All three programs reuse the saved address on that device. Quit and reopen the app after changing the default in your terminal. For a single CLI invocation, `--server URL` takes precedence over `SUPERBOT_SERVER`, and either takes precedence over the saved address. The desktop also honors `SUPERBOT_SERVER` at launch. With no explicit or saved address, clients use `http://127.0.0.1:5173`.

Sign in to the same Superbot server and account on each device to see your workspaces. Desktop and CLI share the device credential vault for that server. The saved server address lives in `server.txt` under the Superbot settings directory. On Windows this is `%LOCALAPPDATA%\Superbot`, on macOS it is `~/Library/Application Support/Superbot`, and on Linux it is `$XDG_CONFIG_HOME/superbot` (default `~/.config/superbot`). Email-code sign-in requires mail delivery on the host.

## Private appearance files

Keep your appearance pack in the `appearance` subdirectory of your Superbot settings directory. To transfer it, quit Superbot, copy your appearance files through a private channel you control, and preserve their relative paths in the destination’s appearance folder. Reopen Superbot and sign in separately on the destination device.

To use the same type on both clients, copy `typography.json` and its `fonts/` directory together. Each optional role, `sans` or `mono`, takes a relative OpenType or TrueType file path and a list of family names. Supply the names from the font itself. Windows and macOS can report different names for the same face. The first available family wins. A missing role uses the bundled Geist family for that role.

```json
{
  "sans": { "file": "fonts/ExampleSans.ttf", "families": ["Example Sans Text", "Example Sans"] },
  "mono": { "file": "fonts/ExampleMono.otf", "families": ["Example Mono"] }
}
```

For matching bot avatars, keep the same `avatars/` directory on both clients. It contains `pack.json` and the shape files it references. A private pack with a live engine also needs its complete `avatars/engine/` directory. The desktop runs that engine locally for pointer and work animations. A pack with recorded frames still works on its own. Import the bot names into the shared Space once. Each client looks up names in its own pack regardless of the new server IDs. The [avatar pack reference](../../native/avatars/README.md) covers name matching, colours, hover and working frames, and chat tints.

## Conversations and shared Spaces

At first sign-in, keep Personal, create a workspace or join with an invite. On your next visit, Superbot opens the last workspace you selected for that account and server. Use the Space switcher to move between workspaces. With a single Space, find these actions in the account menu. Select an agent or group to open its chat. To create a bot, choose **+ → New bot**, press Ctrl+N on Windows or Linux, or press Cmd+N on macOS.

Click the bot's name or avatar in the pill at the top of its chat to open the right sidebar. Click its name in the sidebar to rename it. The gear opens the agent's instructions, job and notification settings. The model name in the chat header and the **Model** row in **Details** open the model choice for that particular bot.

Click the avatar in the right sidebar to choose a shape and colour. The selection belongs to the shared bot. Other members see the change, and **Reset** restores the appearance supplied by their local pack.

Choose **+ → New conversation with …** for a separate chat with the open bot. The shortcut is Ctrl+Shift+N on Windows and Cmd+Shift+N on macOS. Switch chats in **Details → Conversations**. Each chat keeps its own messages, files, draft while the app is open, and local CLI history. The bot keeps its model across chats. In **Details → Conversations**, open the row's **⋯** menu to rename, pin or archive an additional conversation. These settings are shared with other members. Archived chats stay readable. Choose **Restore** to write in one again. **Open web workspace** opens the same conversation.

Open **Inbox** from the account menu to see your questions, running work and results in this Space. The **Inbox** tab in the agent sidebar filters them to that bot. Clicking an item opens its conversation and highlights the referenced message. The desktop can read back up to 3,000 messages to find it. Reading an item or moving it to **Done** updates your own inbox. The **Library** tab shows files, pages and apps referenced by the conversation on screen.

Open the **Computer** tab to see the current state, select the shared team computer or a dedicated one, and start or stop it. **Turn on** enables computer tools for the chosen agent. Starting a computer also requires a host configured to run agent computers. [NixOS hosting](nixos-hosting.md#enable-isolated-agent-computers)

Once the computer is running, choose **Watch** to see its screen inside the sidebar. The desktop uses your signed-in session to open the screen. Each member opens their own view from the bot. Choose **Take control** to send keyboard and pointer input, then **Hand back** when finished. Closing the panel or switching agents also hands back control. After an abrupt disconnect, the server expires the control lease.

The agent's folders are listed below the computer, and **Working folder** in its **Library** opens the same list. Open a folder to go in and **Back** to return. Select a text file to preview it. A stopped computer shows the files saved in its home. While it is running, **Download** saves a file to this computer and **Upload** writes files into the folder on screen. If nobody else is using the computer, the desktop takes control only for the upload and then hands it back. While an agent or another member is using it, **Upload** is unavailable.

When an agent waits on you, its question appears as a card in the conversation. Type an answer and press Enter, pick one of its options, or enter a requested key or code in the masked field; **Dismiss** turns a key request down. The value is sent once and never shown again. In a shared Space only the person who started the run can answer its cards. Website logins, payment cards and contacts are entered in the web app.

While connected, the sidebar picks up other Space members' agent and group changes and chat activity, including activity outside the open conversation. A refresh preserves the selected chat, composer focus and typed text, and an open rename draft. The desktop catches up on reconnect. It uses these signals to refresh the sidebar. System chat alerts and other workspace panels have their own update behavior.

To collaborate, open **Manage workspace → People** and copy an invite link. To keep Personal private, create a separate workspace and issue the invite there. Each recipient signs in with their own account and can redeem the link on web, desktop or CLI. [Workspace guide](workspaces.md)

## Models

Agents need a model before they can reply. Open **Manage workspace**, then **Models**. A new account sees the providers the server offers. For a model server on this computer or your network, choose the compatible server entry, enter its address and a key if it needs one, choose **Find models**, pick a model and choose **Connect**. For a hosted provider, paste its API key, fill in any account IDs it asks for, pick a model and choose **Connect**. The server checks the connection and stores the key sealed; the desktop keeps no copy. The first connection becomes the main model, which every agent uses unless it has its own. **Change** beside the main model or an agent picks another connected model.

[Hosted and local runs](desktop-chat-runs.md) compares what a chat turn does on each kind of model.

For an installed CLI, open **Models** and find **On this computer**. Choose **Check** beside the provider. When sign-in is needed, use the CLI's sign-in action or its displayed terminal instructions, then check again. The provider may open its own consent page. Choose an available local model for the agent on this device. The desktop initiates its CLI turns, and completed turns are saved in the shared thread under the signed-in member. Another device can read the conversation using its own Superbot session.

For Codex, turn on **Use installed Codex sign-in** under **On this computer**. This is an opt-in on this device for the current server, Superbot account, and Space. Agent model choices are saved independently. Turn the switch off to return to Superbot's separate ChatGPT sign-in, which is the default. Sign-in and sign-out in Superbot target only that separate profile. Another Space member's actions cannot enable the switch or launch a CLI on this device.

Installed mode requires Codex 0.170.0 or newer and a file-backed ChatGPT sign-in in the Codex home visible to Superbot. This is the absolute `CODEX_HOME` from Superbot's launch environment or the OS user's default `.codex` directory. Keyring-only logins, API-key logins and homes with global `AGENTS.md` or `AGENTS.override.md` are unsupported. Codex checks the login and manages any credential refresh as part of its normal operation. Superbot stores the mode, discards raw status output, and leaves credential files to the Codex process. If the check fails, installed mode stays selected and turns fail until you restore a compatible login or switch back.

Installed Codex turns keep the read-only sandbox, disabled hooks, MCP and plugins, and ephemeral session mode. Superbot starts model discovery in a disposable, signed-out Codex profile. The list reflects models exposed by the installed CLI, and the selected account may have narrower access. Completed replies still use Superbot's shared chat history.

Claude Code keeps its separate-profile flow. The global Claude profile combines account state with personal plugins and settings, and the CLI offers no independently selectable authentication home for this integration. Anthropic also restricts third-party routing via personal subscription credentials. See [Claude Code settings](https://code.claude.com/docs/en/settings) and [Anthropic's authentication terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).


A server-hosted compatible endpoint must be reachable from the server. Private addresses also depend on the server's private endpoint policy. [Windows host guide](windows-local.md)

## Board

Open **Manage workspace**, then **Board**, for the Space's shared tickets. Tickets are grouped by status: To do, In progress, In review, Blocked, Done and Won't do. **New ticket** asks for a title, an owner bot and a priority; a description is optional. Open a ticket to edit it, choose a status to move it at once, and read or add comments. **Save** sends only the fields you changed.

Every member of the Space shares the board. While it is open, changes from other members and from bots appear as they happen. If someone changes the ticket you are editing, the fields you have not touched take their version, and what you typed stays. A note says so, and it warns when they changed a field you are editing; saving keeps your version of that field. After a dropped connection, the board is read again when it reconnects and when the window becomes active.

Board is a Labs feature upstream. If it is off for your account, the section says so and offers **Turn on Board** when the server lets your account switch it. That keeps your other Labs choices. The icon beside **New ticket** opens the web board in the workspace window, for what only the web does, such as Markdown in descriptions and comments.

## Store

Open the grid icon at the bottom of the sidebar to enter **Store**. **Agents** offers the server’s ready-made agents. **Skills** lists Space skills and installable skill packs. **Plugins** lets you discover, install, create and manage plugin packages. **Apps** shows your connected services and the services you can connect.

To connect a service, choose it in **Store → Apps** and follow its sign-in prompt. If the service asks you to use a browser, choose **Open in browser**. When sign-in opens in your default browser, use the same Superbot account and server as the desktop app. After you authorize the service, return to **Apps** to see the connection and choose which agents can use it.

In **Plugins → Discover**, select **Calorie diary**, then **Install → Open**. Enter a date, meal and calories to see the day's total. **All days** includes entries from every date. Grant a bot the **Meals** part in the plugin details so it can read the diary and propose an addition. [Record app walkthrough](build-a-marketplace-plugin.md)

Install **T3 Code inbox** to collect programming requests from you and your agents. Open the app, connect T3, choose a project and confirm the brief to start a supervised thread. Superbot saves the receipt so you can reopen the thread. [T3 Code inbox guide](t3-code-inbox-desktop.md)

If that bot uses a supported model CLI on this computer, open its direct chat and click **Apps** in the composer. You can also type `/apps Log oatmeal with berries, 320 kcal`. Select the app, review the records that will go to the model and choose **Ask**. **Add** saves the proposed fields to the diary. **Skip** discards the proposal. The app's records and the model's answer stay out of the shared chat transcript.

Choose **Create plugin** to enter a name, identifier, version and description. **Add app** adds fields for text, numbers and dates and an optional numeric total. A plugin can also include a skill or tools from a public HTTPS MCP endpoint. **Submit for review** sends that version to the server. **Yours** shows the decision and lets you prepare another version.

The form reads and writes the `plugin.json` produced by each `superbot-plugin init` template. **Open file…** fills the name, description and parts from a manifest; the identifier and version stay as typed, because a manifest holds neither. A manifest with fields a plugin can't carry, such as headers, commands or another transport, is refused with the field to remove, and the form stays as it was. Values over the registry's limits load with a note on what to fix. When the form has unsaved edits, it asks before replacing them. **Save file…** writes the form to a file you choose, in the CLI's format, and Windows asks before replacing an existing file. A draft that isn't ready to submit can still be saved. **Submit for review** checks the same limits as `superbot-plugin validate`.

On the web, open **Store → Plugins**. Discovery shows the approved releases on the server you signed into. Installs and agent grants belong to the installing account in the selected Space.

A verified deployment reviewer sees **Review** and can inspect each part before approving or rejecting the version. An approved entry appears in **Discover**. Choose **Install**, then **Manage** to give a specific agent access to a specific part. A new installation starts with zero grants. Removing a grant or uninstalling takes effect on the server. [Registry and reviewer setup](plugin-contract.md) · [How the agent uses a granted part](plugin-runtime.md)

For terminal workflows, the plugin toolkit generates and validates the same manifest. Its MCP starter includes a runnable TypeScript server. [Authoring toolkit](plugin-toolkit.md)

When several releases are approved, open the installed plugin, choose the desired version and confirm. Switching clears previous agent grants. A failed switch keeps the current version and grants. Select which agents should receive parts from the new version.

## Open the web workspace

Choose **Open web workspace** in the account menu to open the selected chat in the hosted web client. Cards with a web view open there too. **Open in browser** opens the same page in your default browser.

**Platforms.** Windows uses the Evergreen WebView2 Runtime. macOS uses WKWebView. Linux uses GTK 3 and WebKitGTK 4.1 in a graphical session. The computer screen embeds inside the panel on Windows, macOS and X11. On native Wayland it opens in its own Superbot window.

**Sign-in and cookies.** Sign in on the server’s web sign-in page when the workspace window opens for the first time. Each server and desktop account has its own web profile. On macOS 14 and later, WKWebView keeps an account-specific store. Earlier macOS releases use a private session and ask for sign-in again. Windows stores profiles under `%LOCALAPPDATA%\Superbot\WebView`, and Linux under `$XDG_DATA_HOME/Superbot/WebView` (default `~/.local/share/Superbot/WebView`). Signing out of desktop closes that account’s workspace windows. To end a persistent web session, sign out inside the web workspace. Agent screens use a separate private view.

**External links.** **Open in browser** and links to other sites use your default browser. The browser keeps its own cookies and may be signed in to a different account.

**Links and other sites.** Pages on the server, and sign-in popups the web app opens, stay in the app. Popups share the window's profile so the sign-in can finish. A popup closes when it is done. Other links open in your default browser. If a sign-in moves the whole window to another site, the toolbar names that site and **Back to workspace** returns to the server. Plain `http` addresses on other hosts and `mailto:` links go to the system. `file:`, `javascript:` and other schemes are refused.

**Windows WebView2.** The runtime handles camera, microphone and location permissions, downloads and sign-in popups. Some identity providers require the system browser. Opening the same workspace page again brings its window forward. A different page opens another window, so an open meeting can keep running.

## Developing the UI

On Windows, run `powershell -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1` to rebuild and relaunch the development desktop after changes to native code, assets or the Cargo manifest. The previous build stays open if compilation fails. Use `-Server URL` to choose a fixture, or omit it to use the device's saved server. Press Ctrl+C in the watcher console to stop it. The Vite server provides live reload for the web client. The native app follows system appearance and accepts `SUPERBOT_SKIN=midnight` or `daylight` for visual checks. The Windows [comparison fixture](chat-verification.md) opens a separate desktop backed by disposable accounts, a real database and a deterministic model.

On macOS and Linux, run `scripts/dev-desktop.sh --server URL` for the same rebuild loop, or omit `--server` to use `SUPERBOT_SERVER` or the device's saved server. Set `SUPERBOT_APPEARANCE` to a separate appearance directory for isolated runs, since macOS and Windows resolve appearance independently of `SUPERBOT_CONFIG_DIR`.

On macOS, pass `--server URL --reset-session` to print the chosen origin and clear its saved session before each launch after a successful build, avoiding keychain password prompts from ad-hoc-signed debug builds. This also signs out any installed Superbot that uses the same server.

The [coverage map](parity.md) lists native operations and capabilities available in the full web workspace.

## Desktop font license

The desktop embeds the official Geist and Geist Mono variable fonts from release
[v1.9.2](https://github.com/vercel/geist-font/releases/tag/v1.9.2) under the
SIL Open Font License 1.1. Include the [font license](../../native/desktop/assets/fonts/OFL.txt)
with binary distributions. GPUI's Windows DirectWrite check runs without opening
an app window.

```powershell
cargo test -p superbot-desktop --locked windows_text_system_resolves_bundled_geist_faces
```
