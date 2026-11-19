# Superbot workspace panel

Native GPUI management for one space: bots, shared groups, people and invites, files,
routines, approvals and run activity. It reads and writes through the typed
`superbot-features` client and draws with the tokens in
[`DESKTOP-DESIGN.md`](../../superbot-site/DESKTOP-DESIGN.md) on `gpui-kit 0.10.0`, the same
toolkit as `native/desktop`.

## Use it from the desktop app

```toml
superbot-workspace-panel = { path = "../workspace-panel" }
```

```rust
use superbot_workspace_panel::{open, PanelEvent, Section, WorkspacePanel};

// In its own window: a clone of the signed-in client, the space id, an optional first section.
let panel = open(client.clone(), space_id, Some(Section::People), cx)?;

// Or as a view inside a window you own (a page or the side panel).
let panel = WorkspacePanel::build(client.clone(), space_id, None, window, cx);

cx.subscribe(&panel, |_, event: &PanelEvent, cx| match event {
    PanelEvent::OpenBot { bot_id } => { /* show that conversation */ }
    PanelEvent::OpenGroup { group_id } => {}
    PanelEvent::BotsChanged | PanelEvent::GroupsChanged => { /* re-read the sidebar */ }
    PanelEvent::SpaceLeft { active_space_id } => {}
    PanelEvent::SpaceJoined { space_id } => {}
    PanelEvent::SessionExpired => { /* back to sign in */ }
})
.detach();
```

| Call                                                           | What it does                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `open(client, space_id, initial, cx)`                          | Opens the panel in its own window and returns the view. Calling it again for a space whose window is open brings that window forward.      |
| `WorkspacePanel::build(client, space_id, initial, window, cx)` | Builds the view for a window the host owns. Below 720px wide the section list becomes a row of tabs.                                       |
| `panel.show(section, window, cx)`                              | Switches section.                                                                                                                          |
| `panel.set_space(space_id, window, cx)`                        | Binds the panel to another space of the same session.                                                                                      |
| `panel.refresh(window, cx)`                                    | Re-reads the current section. Call it when the host's live stream signals a change; the panel also does it when its window becomes active. |
| `theme::set_skin(Some(Skin::Midnight), cx)`                    | Pins the skin. Left alone, the panel follows the host's GPUI Kit theme mode.                                                               |

Call `gpui_kit::init` first. Requests run on the Tokio runtime already entered on the calling
thread, or on a small one this crate owns, and their results are applied on the GUI thread.
The icons are embedded, so the host registers no assets for the panel. Bot faces, people's
faces and group stacks are drawn as `native/desktop` draws them, from the same identity key.

## What the server decides

The panel shows controls for what the server says the account may do and reports a refusal
where it happens. Invite and member controls appear only when `spaces/members/list` returns
`canManage`. Leaving is offered to members, not owners. A refused call (HTTP 403) reads
"You don't have permission to …". The server answers HTTP 401 both for an ended session and
for a space the account is not in, so on a 401 the panel reads the account's spaces once: if
the session is dead it emits `SessionExpired`; if only the space is gone it says so and emits
`SpaceLeft`.

## Verify

```powershell
scripts/native.ps1 check -p superbot-workspace-panel --all-targets
scripts/native.ps1 test -p superbot-workspace-panel
```

`tests/fixture.rs` runs the server calls behind the routine, approval, activity and
guest-membership flows against an isolated fixture. It is skipped unless these are set, and it
writes data, so point it only at a disposable fixture with synthetic accounts:

```powershell
$env:SUPERBOT_FIXTURE = 'http://127.0.0.1:5360'
$env:SUPERBOT_FIXTURE_OWNER = 'owner@example.test'
$env:SUPERBOT_FIXTURE_GUEST = 'guest@example.test'
$env:SUPERBOT_FIXTURE_PASSWORD = '…'
scripts/native.ps1 test -p superbot-workspace-panel --test fixture
```

To look at the panel on its own, sign in with a synthetic account:

```powershell
$env:SUPERBOT_SERVER = 'http://127.0.0.1:5360'
$env:SUPERBOT_EMAIL = 'owner@example.test'
$env:SUPERBOT_PASSWORD = '…'
scripts/native.ps1 run -p superbot-workspace-panel --example workspace
```

`SUPERBOT_SPACE` picks a space by name or id, `SUPERBOT_SECTION` a first section such as
`people`, and `SUPERBOT_SKIN` is `midnight` or `daylight`.

## Open risks

- Keyboard: every control is declared as a tab stop with a focus style, and Escape leaves an
  open editor. A keyboard-only pass through the running panel, and what the pinned GPUI
  exposes to screen readers, have not been checked.
- Uploads and downloads hold the whole file in memory as base64, as the artifact RPC requires.
  The panel refuses to read a file over 100 MiB; the server enforces its own, lower limit.
- Bot faces follow the identity key the server stores. `superbot-features` does not expose the
  model catalogue, so a bot's model can be reset to the space's model here but not chosen.
