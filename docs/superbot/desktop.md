# Superbot desktop

The native macOS and Windows apps use Rust and GPUI. Surfaces they do not draw open in the default browser on macOS and in a workspace window on Windows.

## Install from source

On macOS, install Rust with rustup and select a full Xcode installation with the Metal toolchain. On Apple silicon, use the native ARM64 Rust toolchain for an ARM64 build. From the repository root, run:

```sh
bash scripts/install-native-macos.sh
export PATH="$HOME/.local/bin:$PATH"
open "$HOME/Applications/Superbot.app"
```

The installer builds for the Mac's Rust host architecture and puts both commands in the app bundle, with links in `~/.local/bin`. Add the `export` line to your shell profile to keep `superbot` and `superbot-plugin` on your `PATH`. This is a local source build without a Developer ID signature or notarization. Quit Superbot before reinstalling it.

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

Sign in with your existing account on each device. Desktop and the CLI share the credential vault on the same device and origin. The address is stored separately in `server.txt` in `~/Library/Application Support/Superbot` on macOS and `%LOCALAPPDATA%\Superbot` on Windows. Email-code sign-in requires working mail delivery on the host.

## Private appearance files

Keep your appearance pack in `~/Library/Application Support/Superbot/appearance` on macOS or `%LOCALAPPDATA%\Superbot\appearance` on Windows. To transfer it, quit Superbot, copy only your own appearance files through a private channel you control, and put them in the destination's appearance folder with their relative paths intact. Create the folder if needed and reopen Superbot. Keep these files outside the source checkout and app bundle. Sign in separately on the destination device.

To use the same type on both clients, copy `typography.json` and its `fonts/` directory together. Each optional role, `sans` or `mono`, takes a relative OpenType or TrueType file path and a list of family names. Supply the names from the font itself. Windows and macOS can report different names for the same face. The first available family wins. A missing role uses the bundled Geist family for that role.

```json
{
  "sans": { "file": "fonts/ExampleSans.ttf", "families": ["Example Sans Text", "Example Sans"] },
  "mono": { "file": "fonts/ExampleMono.otf", "families": ["Example Mono"] }
}
```

For matching bot avatars, keep the same `avatars/` directory on both clients. It contains `pack.json` and the shape files it references. A private pack with a live engine also needs its complete `avatars/engine/` directory. The desktop runs that engine locally for pointer and work animations. A pack with recorded frames still works on its own. Import the bot names into the shared Space once. Each client looks up names in its own pack regardless of the new server IDs. The [avatar pack reference](../../native/avatars/README.md) covers name matching, colours, hover and working frames, and chat tints.

## Conversations and shared Spaces

At sign-in, desktop opens a Space you already share when one is available. Otherwise it opens the server's default Space. The upper-left menu selects a different Space, and your choice stays active while you work. Select an agent or group in the sidebar to read its history and follow replies. Search filters the sidebar. To create a bot, choose **+ → New bot** or press Ctrl+N on Windows or Cmd+N on macOS. The bot receives an available name and its chat opens.

Click the bot's name or avatar in the pill at the top of its chat to open the right sidebar. Click its name in the sidebar to rename it. The gear opens the agent's instructions, job and notification settings. The model name in the chat header and the **Model** row in **Details** open the model choice for that particular bot.

Click the avatar in the right sidebar to choose a shape and colour. The selection belongs to the shared bot. Other members see the change, and **Reset** restores the appearance supplied by their local pack.

Choose **+ → New conversation with …** for a separate chat with the open bot. The shortcut is Ctrl+Shift+N on Windows and Cmd+Shift+N on macOS. Switch chats in **Details → Conversations**. Each chat keeps its own messages, files, draft while the app is open, and local CLI history. The bot keeps its model across chats. In **Details → Conversations**, open the row's **⋯** menu to rename, pin or archive an additional conversation. These settings are shared with other members. Archived chats stay readable. Choose **Restore** to write in one again. **Open web workspace** opens the same conversation.

Open **Inbox** from the account menu to see your questions, running work and results in this Space. The **Inbox** tab in the agent sidebar filters them to that bot. Clicking an item opens its conversation and highlights the referenced message. The desktop can read back up to 3,000 messages to find it. Reading an item or moving it to **Done** updates your own inbox. The **Library** tab shows files, pages and apps referenced by the conversation on screen.

Open the **Computer** tab to see the current state, select the shared team computer or a dedicated one, and start or stop it. **Turn on** enables computer tools for the chosen agent. Starting a computer also requires a host configured to run agent computers. [NixOS hosting](nixos-hosting.md#enable-isolated-agent-computers)

Once the computer is running, choose **Watch** to see its screen inside the sidebar. The desktop uses your signed-in session to open the screen. Each member opens their own view from the bot. Choose **Take control** to send keyboard and pointer input, then **Hand back** when finished. Closing the panel or switching agents also hands back control. After an abrupt disconnect, the server expires the control lease.

The agent's folders are listed below the computer, and **Working folder** in its **Library** opens the same list. Open a folder to go in and **Back** to return. Select a text file to preview it. A stopped computer shows the files saved in its home. While it is running, **Download** saves a file to this computer and **Upload** writes files into the folder on screen. If nobody else is using the computer, the desktop takes control only for the upload and then hands it back. While an agent or another member is using it, **Upload** is unavailable.

When an agent waits on you, its question appears as a card in the conversation. Type an answer and press Enter, pick one of its options, or enter a requested key or code in the masked field; **Dismiss** turns a key request down. The value is sent once and never shown again. In a shared Space only the person who started the run can answer its cards. Website logins, payment cards and contacts are entered in the web app.

While connected, the sidebar picks up other Space members' agent and group changes and chat activity, including activity outside the open conversation. A refresh preserves the selected chat, composer focus and typed text, and an open rename draft. The desktop catches up on reconnect. It uses these signals to refresh the sidebar. System chat alerts and other workspace panels have their own update behavior.

New accounts start in **Personal**, with the account holder as its only member. To collaborate there from the start, open **Manage workspace** from the account menu or use the settings control at the bottom of the sidebar. Under **People**, choose **Copy an invite link**. To keep existing Personal work private, first choose **New space** in the upper-left menu and send an invite from that Space. Each link can be used once, and the teammate signs in with a separate account. They can redeem it in the browser or paste it under **People** on desktop. Email delivery requires a configured mail service.

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

## Community plugins

Open the grid icon at the bottom of the sidebar to enter **Plugins**. In **Discover**, select **Calorie diary**, then **Install → Open**. Enter a date, meal and calories to see the day's total. **All days** includes entries from every date. To let a bot read your diary and propose an addition, grant it the **Meals** part in the plugin details. [Record app walkthrough](build-a-marketplace-plugin.md)

If that bot uses a supported model CLI on this computer, open its direct chat and click **Apps** in the composer. You can also type `/apps Log oatmeal with berries, 320 kcal`. Select the app, review the records that will go to the model and choose **Ask**. **Add** saves the proposed fields to the diary. **Skip** discards the proposal. The app's records and the model's answer stay out of the shared chat transcript.

Choose **Create plugin** to enter a name, identifier, version and description. **Add app** adds fields for text, numbers and dates and an optional numeric total. A plugin can also include a skill or tools from a public HTTPS MCP endpoint. **Submit for review** sends that version to the server. **Yours** shows the decision and lets you prepare another version.

The form reads and writes the `plugin.json` produced by each `superbot-plugin init` template. **Open file…** fills the name, description and parts from a manifest; the identifier and version stay as typed, because a manifest holds neither. A manifest with fields a plugin can't carry, such as headers, commands or another transport, is refused with the field to remove, and the form stays as it was. Values over the registry's limits load with a note on what to fix. When the form has unsaved edits, it asks before replacing them. **Save file…** writes the form to a file you choose, in the CLI's format, and Windows asks before replacing an existing file. A draft that isn't ready to submit can still be saved. **Submit for review** checks the same limits as `superbot-plugin validate`.

The hosted client exposes the same registry under the account menu in **Integrations → Community**. Discovery covers approved releases on the server you signed into. Installs and agent grants belong to the installing account in the selected Space.

A verified deployment reviewer sees **Review** and can inspect each part before approving or rejecting the version. An approved entry appears in **Discover**. Choose **Install**, then **Manage** to give a specific agent access to a specific part. A new installation starts with zero grants. Removing a grant or uninstalling takes effect on the server. [Registry and reviewer setup](plugin-contract.md) · [How the agent uses a granted part](plugin-runtime.md)

For terminal workflows, the plugin toolkit generates and validates the same manifest. Its MCP starter includes a runnable TypeScript server. [Authoring toolkit](plugin-toolkit.md)

When several releases are approved, open the installed plugin, choose the desired version and confirm. Switching clears previous agent grants. A failed switch keeps the current version and grants. Select which agents should receive parts from the new version.

## Open the web workspace

Choose **Open web workspace** in the account menu for the full Superbot client, including meetings, boards, live voice and the agent computer. A card the native chat does not draw opens there too. It opens the current conversation in a separate Superbot window. That window shows the server's own web app, with all of its navigation, inside Microsoft Edge WebView2. It is not a native view. **Open in browser**, in the same menu and in the window's toolbar, opens the same page in your default browser instead.

**Supported platform.** Windows 10 and 11 with the Evergreen WebView2 Runtime, which Windows 11 includes. Without the runtime the window says so and offers **Open in browser**. On macOS and Linux, **Open web workspace** opens the browser.

**Sign-in and cookies.** The window signs in on its own, on the server's normal sign-in page. Desktop does not pass its session to the window: no token in an address, no injected script, no copied cookie. Each desktop account on each server gets its own WebView2 profile under `%LOCALAPPDATA%\Superbot\WebView\`. The folder name is a hash of the server's canonical origin and the account's user ID, so neither can be read from it. The profile keeps cookies, site storage, cache and saved form data. A different desktop account on the same server never sees an earlier account's web sign-in. Signing out of desktop, or an expired desktop session, closes that account's workspace windows. The web sign-in stays in its profile for that account's next visit. Sign out inside the window to end it. Delete the `WebView` folder while the app is closed to remove every profile. A server that does not report the account's user ID gets the browser instead.

**External links.** **Open in browser** and links to other sites use your default browser. The browser keeps its own cookies and may be signed in to a different account.

**Links and other sites.** Pages on the server, and sign-in popups the web app opens, stay in the app. Popups share the window's profile so the sign-in can finish. A popup closes when it is done. Other links open in your default browser. If a sign-in moves the whole window to another site, the toolbar names that site and **Back to workspace** returns to the server. Plain `http` addresses on other hosts and `mailto:` links go to the system. `file:`, `javascript:` and other schemes are refused.

**Limits.** Camera, microphone and location prompts are WebView2's own, and each permission is saved in the server's profile. Downloads use WebView2's download panel and your Downloads folder. Some identity providers refuse sign-in inside embedded browsers; use **Open in browser** for those. Developer tools are off. Popup windows are WebView2's own windows, without the Superbot toolbar. Opening the same page twice brings its window forward instead of reloading it. A different page opens a second window, so a meeting already open keeps running.

## Developing the UI

On Windows, run `powershell -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1` to rebuild and relaunch the development desktop after changes to native code, assets or the Cargo manifest. The previous build stays open if compilation fails. Use `-Server URL` to choose a fixture, or omit it to use the device's saved server. Press Ctrl+C in the watcher console to stop it. The Vite server provides live reload for the web client. The native app follows system appearance and accepts `SUPERBOT_SKIN=midnight` or `daylight` for visual checks. The Windows [comparison fixture](chat-verification.md) opens a separate desktop backed by disposable accounts, a real database and a deterministic model.

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
