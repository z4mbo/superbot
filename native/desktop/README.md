# Superbot desktop

The native Windows app: Rust and GPUI. Its own views talk to a Rakazo server only through
`superbot-client`. The workspace window is the exception: it shows the server's own web client
in WebView2 for what the native views do not draw. [Using the app](../../docs/superbot/desktop.md) covers what a
person does with it; this note covers how it is built, what it draws, and what it leaves out.

```powershell
cargo run -p superbot-desktop
$env:SUPERBOT_SERVER = "https://rakazo.example.com"; cargo run -p superbot-desktop
cargo test -p superbot-desktop
```

`SUPERBOT_SERVER` picks the server; without it the app uses `superbot_client::DEFAULT_SERVER`.
`SUPERBOT_SKIN=midnight` or `daylight` pins the skin for visual checks; otherwise it follows
the system.

## Layout

| File                | Holds                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `src/theme.rs`      | The two skins as semantic tokens, the radius scale, the fixed measures        |
| `src/api.rs`        | Every server call and its wire types                                          |
| `src/runtime.rs`    | The Tokio runtime the client needs, and the live thread stream with reconnect |
| `src/transcript.rs` | Message blocks turned into what the transcript draws                          |
| `src/app.rs`        | The one `Desktop` entity: session, Space, open conversation, menus, dialogs   |
| `src/ui/`           | One file per surface; each adds `render_*` methods to `Desktop`               |
| `src/web/`          | The workspace window: the web client in WebView2, its profile and link policy |
| `assets/icons/`     | Glyphs drawn for this app, served beside the Lucide set                       |

Views never write a colour, a radius or a text size of their own: colours come from `Theme`,
radii from `theme::radius`, text sizes from the `Type` trait in `src/ui/mod.rs`.

## What it draws

- **Sign in.** Password, emailed code, and creating an account, against any server address.
  The session is kept in the system credential store and restored on launch; a rejected
  session returns to sign-in.
- **Sidebar.** Spaces menu, search, new agent, pinned agents as tiles, agents and groups as
  rows with their last words, unread and working marks, a context menu (rename, pin,
  archive with Undo), the account menu, and the Plugins and workspace buttons.
- **Chat.** History, sending, live replies as they are written, the working line, stop,
  joined bubbles, speaker names in groups, Markdown in replies, approval cards answered in
  place, facts cards and file chips. The composer accepts files with or without a caption.
  Scroll up for older messages, use the timestamps to find an exchange, and type `@` in
  a group to select a member bot. A conversation on screen is marked read as replies arrive.
- **Plugins.** Discover with a search the server runs across the whole registry, Installed,
  Yours, and Review for deployment reviewers. A plugin's page installs and uninstalls it,
  pins it to another approved version after a confirmation, and grants each of its parts to
  each agent. Create plugin writes a manifest (skills and connectors) and submits it; New
  version starts from the last one.
- **Workspace.** The management panel from `superbot-workspace-panel`, mounted in the page.
- **Shared Space updates.** The sidebar subscribes to server notifications, refreshes the
  agent and group lists on changes, and catches up on reconnect. An open chat keeps its
  focus and its draft when another member edits the Space.
- **Open web workspace**, in the account menu, opens the server's web app on the
  conversation on screen, for everything below, in a window of this app (Windows, WebView2).
  **Open in browser** beside it opens the same page in the default browser.

## What it leaves out

Each of these is reachable through **Open web workspace**; a card of that kind in a
transcript says what it is and links there.

- Provider OAuth sign-in, live voice, calls, meetings and a bot's computer. Compatible-endpoint and API-key model setup use **Manage workspace → Models**.
- Typed and secret answers to ask cards, choice cards, charts, pages and embedded apps.
- Reactions, reply quotes and message search.
- Groups can be opened and written to, but are created and edited in the workspace panel.
- The sidebar's four round controls ease their hover tint over 120ms (`src/ui/corner.rs`).
  Every other hover fill still changes at once.
- The window chrome was verified on Windows. macOS and Linux builds and appearance remain unverified.

## Checking a change

Unit tests cover the transcript model, manifest identifiers and the web link. Everything on
screen is checked by running the app against a disposable server and reading captures in
both skins; [the comparison fixture](../../docs/superbot/chat-verification.md) starts one.
Captures use synthetic accounts only.
