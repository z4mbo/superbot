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

## Connect to a server

On each client device, connect to the tailnet and use the same HTTPS web origin advertised by the NixOS host's Tailscale Serve endpoint. Use the origin alone, such as `https://superbot.example-tailnet.ts.net`. See [hosting on another machine](hosting.md#optional-private-access-with-tailscale).

Enter that address in **Server** on the desktop sign-in screen, or set it before launching any of the clients:

```sh
superbot server https://superbot.example-tailnet.ts.net
superbot login
superbot-plugin list
```

The desktop saves the address when you submit sign-in, account creation, or an email-code request with valid fields. All three programs reuse the saved address on that device. Quit and reopen the app after changing the default in your terminal. For a single CLI invocation, `--server URL` takes precedence over `SUPERBOT_SERVER`, and either takes precedence over the saved address. The desktop also honors `SUPERBOT_SERVER` at launch. With no explicit or saved address, clients use `http://127.0.0.1:5173`.

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

## Conversations and shared Spaces

At sign-in, desktop opens a Space you already share when one is available. Otherwise it opens the server's default Space. The upper-left menu selects a different Space, and your choice stays active while you work. The sidebar shows its agents and groups. Select a conversation to load the server history and follow live replies. Search filters the sidebar. The plus button creates an agent. The composer sends messages to the selected conversation.

When an agent waits on you, its question appears as a card in the conversation. Type an answer and press Enter, pick one of its options, or enter a requested key or code in the masked field; **Dismiss** turns a key request down. The value is sent once and never shown again. In a shared Space only the person who started the run can answer its cards. Website logins, payment cards and contacts are entered in the web app.

While connected, the sidebar picks up other Space members' agent and group changes and chat activity, including activity outside the open conversation. A refresh preserves the selected chat, composer focus and typed text, and an open rename draft. The desktop catches up on reconnect. It uses these signals to refresh the sidebar. System chat alerts and other workspace panels have their own update behavior.

New accounts start in **Personal**, with the account holder as its only member. To collaborate there from the start, open **Manage workspace** from the account menu or use the settings control at the bottom of the sidebar. Under **People**, choose **Copy an invite link**. To keep existing Personal work private, first choose **New space** in the upper-left menu and send an invite from that Space. Each link can be used once, and the teammate signs in with a separate account. They can redeem it in the browser or paste it under **People** on desktop. Email delivery requires a configured mail service.

## Models

Agents need a model before they can reply. Open **Manage workspace**, then **Models**. A new account sees the providers the server offers. For a model server on this computer or your network, choose the compatible server entry, enter its address and a key if it needs one, choose **Find models**, pick a model and choose **Connect**. For a hosted provider, paste its API key, fill in any account IDs it asks for, pick a model and choose **Connect**. The server checks the connection and stores the key sealed; the desktop keeps no copy. The first connection becomes the main model, which every agent uses unless it has its own. **Change** beside the main model or an agent picks another connected model.

A provider that connects only by signing in to an account opens web model settings for the same Space. The panel reads the new connection when its window becomes active again. Private model addresses depend on the server's private endpoint policy. The [Windows host guide](windows-local.md) covers local endpoint access and SMTP for email invitations.

## Board

Open **Manage workspace**, then **Board**, for the Space's shared tickets. Tickets are grouped by status: To do, In progress, In review, Blocked, Done and Won't do. **New ticket** asks for a title, an owner bot and a priority; a description is optional. Open a ticket to edit it, choose a status to move it at once, and read or add comments. **Save** sends only the fields you changed.

Every member of the Space shares the board. While it is open, changes from other members and from bots appear as they happen. If someone changes the ticket you are editing, the fields you have not touched take their version, and what you typed stays. A note says so, and it warns when they changed a field you are editing; saving keeps your version of that field. After a dropped connection, the board is read again when it reconnects and when the window becomes active.

Board is a Labs feature upstream. If it is off for your account, the section says so and offers **Turn on Board** when the server lets your account switch it. That keeps your other Labs choices. The icon beside **New ticket** opens the web board in the workspace window, for what only the web does, such as Markdown in descriptions and comments.

## Community plugins

Open the grid icon at the bottom of the sidebar to enter **Plugins**. Choose **Create plugin** to enter a name, identifier, version and description. Add a skill with instructions, or a connector with a public HTTPS MCP endpoint. **Submit for review** sends that version to the server. **Yours** shows the decision and lets you prepare another version.

The form reads and writes the `plugin.json` that `superbot-plugin init` creates, for either template. **Open file…** fills the name, description and parts from a manifest; the identifier and version stay as typed, because a manifest holds neither. A manifest with fields a plugin can't carry, such as headers, commands or another transport, is refused with the field to remove, and the form stays as it was. Values over the registry's limits load with a note on what to fix. When the form has unsaved edits, it asks before replacing them. **Save file…** writes the form to a file you choose, in the CLI's format, and Windows asks before replacing an existing file. A draft that isn't ready to submit can still be saved. **Submit for review** checks the same limits as `superbot-plugin validate`.

The hosted client exposes the same registry under the account menu in **Integrations → Community**. Discovery covers approved releases on the server you signed into. Installs and agent grants belong to the installing account in the selected Space.

A verified deployment reviewer sees **Review** and can inspect each part before approving or rejecting the version. An approved entry appears in **Discover**. Choose **Install**, then **Manage** to give a specific agent access to a specific part. A new installation starts with zero grants. Removing a grant or uninstalling takes effect on the server. [Registry and reviewer setup](plugin-contract.md) · [How the agent uses a granted part](plugin-runtime.md)

For terminal workflows, the plugin toolkit generates and validates the same manifest. Its MCP starter includes a runnable TypeScript server. [Authoring toolkit](plugin-toolkit.md)

When several releases are approved, open the installed plugin, choose the desired version and confirm. Switching clears previous agent grants. A failed switch keeps the current version and grants. Select which agents should receive parts from the new version.

## Open the web workspace

Choose **Open web workspace** in the account menu for the full Rakazo client, including meetings, boards, live voice and the agent computer. A card the native chat does not draw opens there too. It opens the current conversation in a separate Superbot window. That window shows the server's own web app, with all of its navigation, inside Microsoft Edge WebView2. It is not a native view. **Open in browser**, in the same menu and in the window's toolbar, opens the same page in your default browser instead.

**Supported platform.** Windows 10 and 11 with the Evergreen WebView2 Runtime, which Windows 11 includes. Without the runtime the window says so and offers **Open in browser**. On macOS and Linux, **Open web workspace** opens the browser.

**Sign-in and cookies.** The window signs in on its own, on the server's normal sign-in page. Desktop does not pass its session to the window: no token in an address, no injected script, no copied cookie. Each desktop account on each server gets its own WebView2 profile under `%LOCALAPPDATA%\Superbot\WebView\`. The folder name is a hash of the server's canonical origin and the account's user ID, so neither can be read from it. The profile keeps cookies, site storage, cache and saved form data. A different desktop account on the same server never sees an earlier account's web sign-in. Signing out of desktop, or an expired desktop session, closes that account's workspace windows. The web sign-in stays in its profile for that account's next visit. Sign out inside the window to end it. Delete the `WebView` folder while the app is closed to remove every profile. A server that does not report the account's user ID gets the browser instead.

**The browser is the exception.** **Open in browser**, links to other sites, and **Manage workspace → Models** account sign-ins open your default browser. The browser keeps its own cookies and may be signed in to a different account. Desktop does not control which account a browser sign-in uses.

**Links and other sites.** Pages on the server, and sign-in popups the web app opens, stay in the app. Popups share the window's profile so the sign-in can finish. A popup closes when it is done. Other links open in your default browser. If a sign-in moves the whole window to another site, the toolbar names that site and **Back to workspace** returns to the server. Plain `http` addresses on other hosts and `mailto:` links go to the system. `file:`, `javascript:` and other schemes are refused.

**Limits.** Camera, microphone and location prompts are WebView2's own, and each permission is saved in the server's profile. Downloads use WebView2's download panel and your Downloads folder. Some identity providers refuse sign-in inside embedded browsers; use **Open in browser** for those. Developer tools are off. Popup windows are WebView2's own windows, without the Superbot toolbar. Opening the same page twice brings its window forward instead of reloading it. A different page opens a second window, so a meeting already open keeps running.

## Developing the UI

Restart the native build after Rust changes. The Vite server provides live reload for the web client. The native app follows system appearance and accepts `SUPERBOT_SKIN=midnight` or `daylight` for visual checks. The Windows [comparison fixture](chat-verification.md) opens a separate desktop backed by disposable accounts, a real database and a deterministic model.

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
