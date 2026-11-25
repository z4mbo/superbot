# Superbot desktop design

Owner: design. Status: v1, 2026-11-19; presence and motion (§3.2, §3.5, §3.6, §6) 2026-11-20. Implementing agents follow this file; if a rule
blocks the right thing, change the rule here first and say why in the same change.

The visual source of truth is the OpenMausBot fork `z4mbo/bot`, branch `simple-only`,
revision `49b44777d`: its `DESIGN.md`, the Midnight/Daylight tokens in `src/styles.css`,
the Simple-mode components in `src/components/`, and its app icon `public/app-icon.svg`.
Superbot carries that look over, not a new look. OpenMausBot is Apache-2.0
(Copyright 2026 Milind Soni and OpenMausBot contributors); `NOTICE.txt` in this folder
carries the notices for everything adapted from it and from Lucide.

The desktop is the Electron app in `apps/desktop` on Windows, macOS and Linux. It shows the
web UI, so these rules apply to the web components it renders.

---

## 0. What is live and what is not

The table says whether the **server and CLIs** do it today. Nothing marked **Planned** may appear in the shipped app
as a teaser, a disabled button or "coming soon" copy; it is designed now so the layout
leaves room for it.

| Tag          | Meaning                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| **Live**     | Implemented and verified against a real or isolated fixture server (`docs/superbot/*.md`). |
| **To build** | The backing operation exists and the desktop control is pending.                           |
| **Planned**  | No server contract. Design only.                                                           |

| Surface                                                   | Server / CLI                                    | Backed by                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sign in (password or email code), saved session           | Live (`superbot login`)                         | `sign_in`, email OTP, the system credential store                                |
| Space switcher                                            | Live                                            | `spaces/list`                                                                             |
| Bot list, history, send, live replies                     | Live (`superbot <agentname>`)                   | `bots/list`, `threads/{messages,send,subscribe}`                                          |
| Group conversations (several bots), stop, mark read       | Live                                            | `groups/*`, `threads/{send,stop,markRead}`                                                |
| Space members and invites (multiplayer)                   | Live, cross-account verified                    | `spaces/members/{list,add,remove,leave}`, `spaces/invites/{create,preview,accept,cancel}` |
| Marketplace: discover, install, per-bot grants, uninstall | Live, full lifecycle verified locally           | `pluginRegistry.*`                                                                        |
| Remote tools from plugins, approved per call              | Live                                            | marketplace runtime and `threads/answer`                                                  |
| Installed record apps | Live. People and granted bots can read records. Adding a record from a hosted bot requires approval. | `pluginRegistry/{appRecords,addAppRecord,removeAppRecord}` |
| Plugin authoring and submission                           | Live (`superbot-plugin`)                        | `pluginRegistry.submit/mine`; `docs/superbot/plugin-toolkit.md`                           |
| Review queue (deployment admins)                          | Live (`superbot-plugin review`)                 | `pluginRegistry.submissions/review`, admins via `SUPERBOT_ADMIN_EMAILS`                     |
| Presence ("who is here") and typing                       | Planned                                         | no contract                                                                               |
| Bot colour, avatar, preview line in the sidebar           | The navigation response includes bot summaries. | `spaces/list`                                                                             |
| Routines, approval rules, run activity                    | Live (server)                                   | `routines/*`, `approvalRules/*`, `runs/list`                                              |
| Board: tickets by status, edit, move, comments            | Live (Labs feature per account)                 | `boards/{get,subscribe}`, `tickets/{list,create,update,move,comment,comments}`            |
| Agent computer | Live on hosts with computer provisioning | `computer/*` |
| Voice and calls | Available in the web client on configured hosts | retained app/API |

Asks from design to the client/runtime owners (UI code must not invent these):

1. `Agent { color, avatar_url, last_message_preview, last_activity_at, unread }` in the
   client API, or a documented call that returns them.
2. A typed `ThreadEvent.kind` catalogue (message created/completed, run started/finished/
   failed, approval requested/answered, member joined/left).
3. One registry client that the store and `superbot-plugin` share.
4. Presence and typing events, if multiplayer presence is wanted.

## 1. Provenance rules (security and licensing)

- **Use**: OpenMausBot's own tokens (Midnight, Daylight, `identity-*`), its type table,
  radius scale, layout numbers and its app icon (the round bot face on a black tile).
- **Fonts**: Geist and Geist Mono (SIL OFL 1.1). Bundle the `.ttf`/`.otf` files with their
  licence in the app. A person may use their own faces on their own computer through a
  private typography pack (§3.3); the app never bundles or downloads one.
- **Never ship** anything from `OpenMausBot/src/grok-study/`: the `XVF` fonts, the `--gk-*`
  palette, `roster.json` and the engine chunks are another product's assets copied "for
  local study only". Do not copy third-party product marks (Grok, Claude, Codex, Gemini
  logos in `AgentMarks.tsx`) unless a feature truly names that provider and the licence
  allows it.
- **Screenshots**: screenshots of a real OpenMausBot install contain real names and
  conversations. Keep them outside the repository (never committed, never in this
  folder); every image that ships uses invented test data. The landing page mock is HTML
  with invented data for this reason.
- **Local avatar override**: an OpenMausBot checkout may load a git-excluded
  `src/grok-study/BotAvatarOverride.tsx` that draws bots as another product's shapes and
  tints their chats. Superbot's shipped reference stays the default Simple mode without it
  (neutral own bubbles, face glyph avatars). The override's look reaches Superbot only as a
  **local avatar pack** the person exports on their own computer into the appearance folder
  (§3.2); the pack, the exporter and anything they read stay out of the repository and
  every build.

## 2. Principles (carried over from OpenMausBot `DESIGN.md` §1–2)

1. Calm by default: no blinking, counting or competing unless the person must act. (Bot faces
   blink now and then only in the open conversation, §3.2; that is presence, not a call for attention.)
2. Three places only: **sidebar** (spaces, bots, conversations), **chat**, **side panel**
   (one bot's details, or a plugin's details). Full-width **pages** (Marketplace, Plugin
   creator) temporarily replace the chat area; they are not a fourth place.
3. No new header buttons, no count badges above lists, no confirm dialogs; reversible
   actions offer **Undo** in a toast instead. The one kept ask is the per-call tool
   approval (§9.2), which the runtime requires.
4. Name it, don't explain it. One primary action per view.
5. Every state designed: empty, loading, error, offline, long text, narrow window, both skins.
6. Keyboard first, reduced motion respected, right-to-left mirrors.

## 3. Tokens

Keep one theme with these fields; components read it and never hard-code a colour. Values are
sRGB hex with alpha last (`0xRRGGBBAA`).

### 3.1 Colour

| Token                  | Job                      | Midnight (dark)       | Daylight (light)      |
| ---------------------- | ------------------------ | --------------------- | --------------------- |
| `app`                  | chat ground              | `#121212`             | `#fcfcfc`             |
| `panel`                | sidebar, title bar       | `#0e0e0e`             | `#f5f5f5`             |
| `raised`               | selected sidebar row     | `#202020`             | `#e4e4e4`             |
| `raised_hover`         |                          | `#2c2c2c`             | `#d8d8d8`             |
| `card`                 | bot bubble, cards        | `#1f1f1f`             | `#efefef`             |
| `inset`                | search field             | `#1b1b1b`             | `#e9e9e9`             |
| `control`              | chip on a card           | `#282828`             | `#e3e3e3`             |
| `composer`             | composer pill            | `#1f1f1f`             | `#ffffff`             |
| `composer_ring`        | its 1px ring             | `ink` 10%, 22% hover  | `ink` 10%, 22% hover  |
| `menu`                 | menus, popovers          | `#1f1f1f`             | `#ffffff`             |
| `menu_hover`           |                          | `#f5f5f50f`           | `#1c1c1c0f`           |
| `menu_active`          |                          | `#f5f5f514`           | `#1c1c1c14`           |
| `hairline`             | borders, dividers        | `#383838`             | `#1c1c1c3d`           |
| `edge`                 | where panes meet (0.5px) | `#f5f5f50f`           | `#1c1c1c1f`           |
| `ink`                  | primary text             | `#f5f5f5`             | `#1c1c1c`             |
| `ink_secondary`        | supporting text          | `#f5f5f5a8`           | `#1c1c1cad`           |
| `ink_tertiary`         | meta, placeholders       | `#f5f5f591`           | `#1c1c1ca6`           |
| `accent`               | links, selection         | `#1084fe`             | `#126fd4`             |
| `accent_text`          | accent-coloured text     | `#7fc0ff`             | `#0b69cc`             |
| `accent_ink`           | text on accent           | `#ffffff`             | `#ffffff`             |
| `focus`                | keyboard ring            | `#459ffe`             | `#0b6dd3`             |
| `success` / `_ink`     |                          | `#38d591` / `#072114` | `#007a44` / `#ffffff` |
| `warning`              |                          | `#ff9800`             | `#9c5b00`             |
| `danger` / `_ink`      | destructive, errors      | `#ff5667` / `#ffffff` | `#cd2834` / `#ffffff` |
| `bubble_user` / `_ink` | the person's own bubbles | `#5a5a5a` / `#f5f5f5` | `#1c1c1c` / `#fcfcfc` |

Hover fill = `ink` at 6% alpha on every surface; pressed fills per control family are in §3.6.
Hierarchy comes from the
three ink levels, never from a fourth grey. Accent is rare; the primary button is a neutral
ink pill (`ink` fill, `app` text). Skin follows the OS appearance
(`window.appearance()`), with a manual override in Settings.

### 3.2 Bot identity colours

Used only for things owned by one bot: its avatar plate, that chat's Send button, and the
Allow once button on its approval cards. The person's own bubbles stay neutral
(`bubble_user`), as in OpenMausBot's default Simple mode.

**Built-in bot face**: a lit sphere in the identity colour with the app icon's two vertical
eyes. It fills its slot; there is no plate. Fractions of the
diameter `d`, origin at the slot's top start:

- Body: circle, `linear_gradient(150°, mix(C, white, 0.16), mix(C, black, 0.22))`, light at the
  top start. `C` and the eye colour come from `identity_paint` (Staff White: body `ink`, eyes `app`).
- Rim (d ≥ 20): inset shadows, black α 0.22 / 0.16 (Midnight / Daylight) at (0, −0.04d) blur 0.10d,
  and white α 0.18 / 0.30 at (0, 0.03d) blur 0.05d.
- Shine (d ≥ 20): ellipse 0.40d × 0.24d centred (0.36d, 0.22d), white α 0.30 / 0.36 fading to 0
  downward; halved on a light body.
- Contact shadow (d ≥ 42, never on the back face of a group pair): black α 0.40 / 0.14 at
  (0, 0.05d), blur 0.10d, spread −0.06d.
- Eyes: 0.14d × 0.21d pills, centres x 0.5d ± 0.15d, y 0.47d; whole pixels below 24.
- Gaze (rows, tiles, the main bot card, the header pill, the new-conversation face): pointer
  offset over `clamp(4d, 64, 160)`, chased at rate 10/s. Eyes move 0.09d across and 0.07d up or
  down, narrow by up to 20% toward the edge, and the shine moves 0.03d the other way, so the
  head turns on the sphere. Press: eyes recentre and squash (height ×0.82) in 70ms, back in 160ms.
- Blink: height to 12% in 60ms, hold 30ms, back in 120ms. Only the open conversation's faces,
  every 4.5–8s per bot; also on pointer entry, when waiting starts and when the model changes.
- States (asleep > failed > waiting > working > rest, 240ms between them): **working**, eyes
  read side to side (0.07d, 2.4s loop, each bot at its own phase, 30fps); **waiting for you**,
  eyes 10% larger, still; **failed** (only if the bot summary reports it), eyes lowered and half
  shut; **asleep** (exactly while the "Connect an AI model" banner shows), eyes closed as thin
  horizontal pills. Status dots stay in every state.
- Reduced motion: no gaze, blink, squash or loop; light and shadow stay.

A bot with its own image shows the image instead. No initials. Faces redraw only while
something on them moves; a sidebar of 2,000 bots with 40 visible and 10 working keeps every
frame under 8.3ms.

The application icon has a horizontally centred white circle that fills the bottom of its black tile. Two equal vertical
eyes sit at the same height on either side of the centre. Platform launchers, the web
app and the site share the artwork in `assets/logo.svg`.

**Local avatar pack**: when the appearance folder holds
`avatars/pack.json`, every bot avatar is the pack's mark instead of the face, matched by
bot name, then by server colour, then by id. The mark is drawn in a square 1.55 × the slot
(56 for the 42 row slot), centred and allowed past the slot, so slot sizes and layout do
not change: tile 56, row 42 (36 of layout), header pill 22, new conversation 64, working
line 28, plugin page 28, workspace panel 40 and 32, mention list 20, group pair 0.68 ×.

- A named bot with `primaryTile` becomes the main bot card (§6) even on a fresh import, ahead of
  the first pinned bot. No badge marks it. Search shows the bot in the results list.
- The pack wins whole: none of the built-in face's light, shine or shadow is applied to a mark.
- Rest: the still pose. Over a sidebar row, a tile or the header pill the mark turns toward
  the pointer (about 0.75 s), follows it, and turns back when the pointer leaves or presses.
  A bot at work (its sidebar status, the open chat, an activity run) loops its working
  motion at 30 fps, each bot at its own place in the loop; the working line shows the
  moving mark instead of the green dot. Status dots stay as they are.
- Chat tint: in a one-bot chat the person's bubbles and the Send and Stop button take the
  pack's colours for that bot, per skin; groups and every other surface keep the tokens
  above. Group speaker names take the mark's colour.
- No pack, a broken pack, or a shape whose frames fail to load: the face above, unchanged.

| Native identity | Server palette   | Midnight  | Daylight  |
| --------------- | ---------------- | --------- | --------- |
| neutral         | Staff White      | `#f5f5f5` | `#1c1c1c` |
| purple          | Executive Violet | `#8d69ce` | `#8057c8` |
| green           | Emerald          | `#009957` | `#007f48` |
| orange          | Forge Orange     | `#e78531` | `#a95914` |
| teal            | Cyber Cyan       | `#01a492` | `#017c6f` |
| blue            | Cobalt Blue      | `#377fe6` | `#1b6adc` |
| yellow          | Amber Gold       | `#d8a729` | `#896a19` |
| bronze          | Caramel Bronze   | `#a8805a` | `#8a6440` |
| red             | Crimson Red      | `#d94b52` | `#d12c34` |
| pink            | Neon Pink        | `#d84f8b` | `#ca2d72` |
| slate           | Slate Silver     | `#8a94a6` | `#5f6b7d` |
| cyan            |                  | `#0ea5c6` | `#0a7891` |
| coral           |                  | `#e5634e` | `#cd361e` |

Staff White takes its fill from `ink` and its eyes from `app` (`#121212` Midnight,
`#fcfcfc` Daylight). Cyan and coral stay available for local identities. Unrecognised
avatar values still hash into the original ten colours. The server's current and
previous hex values match without regard to case or the avatar's shape suffix.

Filled surfaces (own bubble, Send button) follow OpenMausBot `src/lib/user-bubble-tone.ts`:
keep the colour if white text clears 4.5:1 on it; otherwise take the brightest OKLCH tone
at the same hue and chroma that does. Yellow-family hues (OKLCH 65–115°) use dark ink
`#101410` instead. Precompute the palette fills at build time into the `Theme`; do not run
contrast maths per frame. Hover moves the fill 12% away from its ink, pressed 22%.

### 3.3 Type

Geist for text, Geist Mono for code, keys, slugs and JSON. Weights 400 / 500 / 600 only.
Sentence case everywhere.

**Private typography pack.** At start the desktop reads `typography.json` from the
appearance folder (`SUPERBOT_APPEARANCE`, else `%LOCALAPPDATA%\Superbot\appearance` on
Windows and `~/Library/Application Support/Superbot/appearance` on macOS):
`{"sans": {"families": [...], "file": "fonts/…"}, "mono": {...}}`. Files are TrueType or
OpenType, relative to that folder; the first family name this computer's text system knows
wins, and a role whose file or family does not load falls back to Geist. DirectWrite names
the faces of a variable font with an optical-size axis after its cut (`Name Text`,
`Name Display`), CoreText by its typographic family, so a pack lists both. The pack and its
setup script live only in that folder, never in this repository or a build.

| Use                                      | Size / line height              | Weight           | Ink                                 |
| ---------------------------------------- | ------------------------------- | ---------------- | ----------------------------------- |
| Page title (Marketplace, Plugin creator) | 26 / 32, letter-spacing −0.01em | 600              | ink                                 |
| Dialog or sheet title                    | 20 / 28                         | 600              | ink                                 |
| Section title                            | 17 / 24                         | 600              | ink                                 |
| Chat bubble                              | 15 / 22                         | 400              | ink                                 |
| Menu item                                | 14 / 18                         | 400              | ink                                 |
| Body, row previews, day stamps           | 13 / 18                         | 400              | ink or ink_secondary                |
| Names in lists and the header pill       | 14 / 20                         | 500              | ink                                 |
| Main bot card name (§6)                  | 15 / 22                         | 600              | ink                                 |
| Composer field                           | 14 / 20                         | 400              | ink, placeholder ink_secondary      |
| Speaker names (multiplayer)              | 13 / 18                         | 600              | identity colour, else ink_secondary |
| Meta, hints, group labels                | 12 / 16                         | 400 (labels 500) | ink_tertiary                        |
| Keycaps, tiny badges                     | 11 / 14                         | 400              | ink_secondary                       |

Truncate titles and rows to one line with an ellipsis and a tooltip with the full text.
Counters, timers and versions use tabular figures (`font_features: tnum`).

### 3.4 Shape, space, depth

| Element                          | Radius                           |
| -------------------------------- | -------------------------------- |
| Buttons, pills, chips, avatars   | full                             |
| Menu rows                        | 6                                |
| Fields, controls, sidebar rows   | 8                                |
| Cards, menus, popovers           | 12                               |
| Dialogs                          | 14                               |
| Bubbles, cards in the transcript | 18 (6 on joined corners)         |
| Composer                         | 22 single line, 18 once it wraps |
| Window panes                     | 0                                |

- 4px grid. Control heights 24 / 28 / 32 / 36; menu rows 30.
- Borders 1px `hairline`; panes meet on a 0.5px `edge` line.
- Only floating things cast shadows (menus, popovers, dialogs, toasts):
  Midnight `0 8 24 rgba(0,0,0,0.5)` + 1px `hairline`; Daylight `0 8 24 rgba(0,0,0,0.12)`.
  The header pill wears the composer's shadows (§7.4); in Midnight both add a 1px inner top
  light (white α 0.04). Bot faces carry their own light (§3.2).
- The transcript fades under the floating pieces: 48px at its top from `app` α 0.92 to 0, and
  24px above the composer from `app` α 0 to 1. Neither takes the pointer.
- Dialog scrim: `#000000` at 50% (Midnight), 25% (Daylight). Nothing else dims the app.
- Icons: Lucide, 16px in rows and toolbars, 14px next to 12–13px text, stroke 1.75.
  Bare icons, never in tinted squares. Embed the SVGs you use (Lucide is ISC).

### 3.5 Motion

Two curves, each a `bezier(x1, y1, x2, y2)`:
**standard** `(0.4, 0, 0.2, 1)` for colour and opacity that go and come back, **emphasis**
`(0.22, 1, 0.36, 1)` for things that enter or move. `Tint` (reversible, "faster reversing")
lives there too.

| Name           | ms        | Curve    | Use                                                                                       |
| -------------- | --------- | -------- | ----------------------------------------------------------------------------------------- |
| `instant`      | 0         | –        | hover entering rows and menu rows; closing menus, popovers, tooltips; focus rings         |
| `quick`        | 90        | standard | hover leaving sidebar rows and tiles                                                       |
| `press`        | 60        | standard | into the pressed fill; release goes back with `hover`                                      |
| `hover`        | 120       | standard | buttons, pill halves, composer ring, tabs, file cards, switch track, empty → ready Send    |
| `fade`         | 120       | standard | tooltips in (2px), conversation switch (transcript 60% → 100%), working row, model label  |
| `grow`         | 100       | emphasis | composer height                                                                            |
| `pop`          | 160       | emphasis | menus and popovers in: fade + 4px from the trigger's side                                  |
| `slide`        | 160       | emphasis | tab indicator, switch knob, chevron turning 180° while its menu is open                  |
| `msg`          | 180       | emphasis | a live message at the bottom: 6px rise + fade (4px for the person's own)                  |
| `panel`        | 200 / 180 | emphasis | side panel width in / out; the chat column narrows with it, the panel's content does not reflow |
| `state`        | 240       | emphasis | a bot face changing state                                                                  |

Tooltips wait 500ms, or nothing if another closed within the last 600ms. Pages fade, they do
not slide. If a `panel` frame takes over 12ms with 500 messages on screen, the chat takes its
final width at once and only the panel moves.

300ms ceiling for anything that is not a loop. Nothing scales from zero. Loops: a working
bot's face and the working row's shimmer. Never animated: streaming text, a row becoming
selected, list reordering, unread dots, focus rings, the caret, scrolling (left to the
platform; "Jump to latest" jumps), window resizing, skin changes, errors, closing.
If the OS asks for reduced motion, every duration becomes 0 and no loop runs; tooltip delays
stay.

### 3.6 States and focus

Pressed fills: elevated controls (the 36px round buttons, header pill halves) go to
`mix(composer, ink, 0.12)`; rows to `raised`, a selected row to `raised_hover`; menu rows and
quiet buttons to `ink` 8–10%. Disabled: opacity 0.4 (0.5 for Send), no hover, out of Tab.

| Family                       | Rest                                   | Hover                                  | Selected / open                         |
| ---------------------------- | -------------------------------------- | -------------------------------------- | --------------------------------------- |
| Sidebar rows, pinned tiles   | none                                   | `raised` 50%                           | `raised`                                |
| Main bot card (§6)           | `ink` 4% + 1px `ink` 6% ring           | `ink` 6% + ring `ink` 10%              | `raised` + ring `ink` 10%               |
| Round elevated buttons       | `composer` + inset ring `ink` 6%       | `elevated_hover`                       | hover fill held while its menu/page is open |
| Header pill halves           | none on `composer`                     | `elevated_hover`                       | hover fill held while panel/menu is open |
| Composer `+`                 | `ink` 4% fill and ring, `ink_tertiary` | `ink` 8%, `ink_secondary`              | `ink` 8% while its menu is open          |
| Tabs and segmented controls  | `ink_secondary` on a `ink` 5% track    | `ink` text, `ink` 4%                   | `ink` 10% indicator that slides, `ink` 500 |
| Switches (32 × 18, knob 14)  | off: track `ink` 18%, knob `ink`       | track `ink` 24% / `ink` 86%            | on: track `ink`, knob `app` (monochrome) |
| File cards                   | `card` + 1px `ink` 8%                  | ring `ink` 16%                         | –                                       |

**Focus** shows only after keyboard input (`window.last_input_was_keyboard()`), always 2px
`focus`, in one of two forms: **outside** with a 2px gap (radius + 4) on standalone controls
(round buttons, composer buttons, switches), **inside** at the element's own radius on anything
in a list or container (rows, tiles, the main bot card, pill halves, tabs, link buttons in
cards). Menu rows show focus as their hover fill. Text fields show focus as the `ink` 22%
ring and the caret, never the blue ring. Rows, tiles and both pill halves are Tab stops; a
focused row shows its `⋯`.

## 4. Window shell

```
┌──────────────── sidebar ────────────────┬──────────────── chat area ───────────────────┬── side panel ──┐
│ [traffic lights / 84px]     (⌕)  (+)    │            ( ● Bot name · model ▾ )          │  optional      │
│ ▢ Inbox                                 │                                              │  400 default   │
│ [◉ Main bot  name / latest line   ]     │      transcript column, max 960, centred     │  320–960       │
│ ◉ Bot row  name / preview          ⋯    │                                              │                │
│ ◉ Bot row                               │                                              │                │
│ …                                       │   ╭ (+)  Message Bot name…        (🎙)(➤) ╮   │                │
│ (◯ You)                        (⊞ Store)│   ╰──────────────────────────────────────╯   │                │
└─────────────────────────────────────────┴──────────────────────────────────────────────┴────────────────┘
```

- Default window 1280×820, centred in the display's visible area and never larger than it;
  minimum 760×520. Remembering size and position per display is To build.
- **Title bar**: transparent on every platform, and the app owns the drag region. On macOS the traffic lights centre 26px from the top, like the Windows caption glyphs, and
  84px at the sidebar's start stay clear for them (also at the chat header's start while the
  sidebar is hidden); in full screen nothing is reserved. When the skin is chosen rather than
  following the system, the window appearance follows the skin so the lights and window edge
  match it. On Windows/Linux draw our own caption buttons
  (minimise, maximise, close; 46×52 each, hover `ink` 6%, close hover `danger` with
  `danger_ink`) at the window's top end, over the chat area. The top 52px is a drag region
  except over controls; on macOS the app moves the window itself, and a double click does what
  the system setting says.
- **Sidebar**: `panel` fill, default width 354, drag its end edge (12px hit area) between
  92 (avatar rail) and 400; snaps to the rail below 200. Maximum 280 while the side panel is
  open. `Cmd/Ctrl+\` toggles it; below 960px window width it overlays the chat with a scrim.
- **Chat area**: `app` fill. Header pill floats 10px from the top, centred. Transcript
  column max 960 wide, 24px side padding. Composer floats at the bottom, same column width,
  16px from the bottom edge.
- **Side panel**: `panel` fill, 0.5px `edge` on its start side, default 400, resizable
  320–960, enters with `panel` motion. One panel at a time.
- **Pages** (Marketplace, Plugin creator, Review queue): fill the chat area, content max
  1240 wide, 32px side padding, 56px top padding, with a back chevron before the title.
  Opening a bot or conversation closes the page.

### 4.2 Board (workspace panel)

A section of the workspace panel, between Files and Routines, with the `kanban` glyph. It
uses the panel's page layout and controls; no new tokens.

- **List.** Title "Board", then a quiet icon button that opens the web board and the
  primary **New ticket** pill (off until bots load, and when the Space has none). Tickets
  are grouped under a `group_label` per status, in upstream order, as "To do · 2"; empty
  statuses are left out. A row: status glyph (`warning` for Blocked, `success` for Done,
  else `ink_secondary`), the title, then "ref · owner · priority (when not Normal) ·
  updated …".
- **Ticket.** Back chevron and the title; a meta line "ref · opened … · updated …".
  **Status** is a row of small chips that move the ticket on press. Title, Description,
  **Owner** (one chip per bot) and **Priority** chips save together with **Save**, which
  stays off until something differs. A divider, then Comments: author, relative time,
  text, a comment field and **Comment**.
- **Someone else's change** shows one line above the title field: `ink_secondary` when it
  only touched fields not being edited, `warning` when it touched one being edited.
- **Off for the account.** One notice line, with **Turn on Board** as a link button when
  the account may switch the Lab.

## 5. Sign in

Centred card, 400 wide, `card` fill, radius 14, 32px padding, app icon 56px above.

1. Title "Sign in to Superbot".
2. Field "Server" (default `https://` + last used; Geist Mono 13). Validate on blur with
   `Client::new`: an `InvalidServer` error shows inline under the field:
   "Use an HTTPS address, or a local address such as http://127.0.0.1:3000."
3. Fields "Email", "Password" (36px, radius 8, `inset` fill, 1px `hairline`; focus colours
   the border `focus`).
4. Primary ink pill "Sign in" (36px, full width). While pending: "Signing in…", fields
   read-only, layout unchanged. Under it a text button "Email me a code instead" swaps
   the password field for a 6-box code field (Geist Mono 20, tabular) after sending the
   code; "Send a new code" appears after 30s. Same flow as `superbot login --code`.
5. Errors inline above the button: 401 → "That email and password don't match.";
   transport → "Couldn't reach the server. Check the address and that you're online.";
   `CredentialStore` → "Signed in, but couldn't save the session to your system keychain.
   You'll need to sign in again next time." (non-blocking).

On launch: `CredentialStore::load`; if a client comes back, skip this screen. Any later
`is_unauthorized()` returns here with the server and email prefilled and a one-line note
"Your session ended. Sign in again." Sign out lives in the profile menu.

## 6. Sidebar

Top row (56px tall, 12px top padding): traffic-light space (84px on macOS outside full
screen, 8px elsewhere), then at the end, 16px from the edge, two 36px round
icon buttons 10px apart, each a charcoal "elevated control": `composer` fill (`#1f1f1f`
Midnight, `#ffffff` Daylight), a 1px inset ring of `ink` at 6%, icon in `ink` at 90%
(`corner-search` 16px: a 5px-radius ring and handle at stroke 1.7; Lucide `plus` at 20px,
stroke 2; both measured against the installed reference header at 1×), hover fill =
`composer` mixed 7% toward `ink`. They are **Search** (`search`, `Cmd/Ctrl+K`) and **New**
(`plus`, click to open the creation menu). Cmd/Ctrl+N creates a bot directly. While a bot is open,
Cmd/Ctrl+Shift+N starts another conversation with it.

- **Space switcher**: only when `list_spaces` returns more than one; with one Space the
  top row's start stays empty. A 36px pill at the top row's start: space name 14/500 +
  `chevron-down` 14px; opens a menu of spaces (check mark on the current one) and "New
  space…". With one Space the account menu carries the same rows under the email. The
  selection persists per server.
- **Inbox** opens from the account menu. Each bot has its own Inbox tab in the right panel.
- **Main bot card**: the first pinned bot (or a pack's `primaryTile` bot) opens the list as a
  full-width card, x 12–342, 72 tall, radius 12, 8px above and below. Face 48 (§3.2) 12px from
  the start, vertically centred; from 72px: name 15/22/600 `ink`, 2px above the latest line
  13/18 `ink_secondary` (`warning` when it waits for you, "Working…" while it works). Status dot
  and unread dot as on rows. Hover turns the face and reveals the row's 24px `⋯` (Rename…, New
  conversation, Open details, Unpin, Remove); nothing else. No badge. No pinned bot, no card:
  nobody is promoted silently. Groups never take it; search hides it; it scrolls with the list.
  In a narrow rail it becomes a 56 × 56 tile (radius 12, face 44, name in the tooltip).
- **Other pinned bots** follow as 78 × 92 tiles (radius 8, avatar 56, name below). Hovering one
  with a preview for 250ms opens a 260px card beside it (`pop`).
  Tab focuses the card and tiles. Enter or Space opens the bot, and the Menu key or Shift+F10 opens its actions.
- **Bot rows**: 54px tall, radius 8, 8px inline padding, 10px gap. Avatar 42 with a −3px
  margin, so it takes 36px and names start 66px from the sidebar's edge. Name 14/20/500
  `ink`, 3px above the last-message preview 13/18/400 `ink_secondary`, one line each, the
  pair centred. Selected row `raised`; hover `raised` at 50%, in at once and out
  in `quick`; pressed and focus in §3.6. A 24px `ellipsis`
  button appears at the row's end on hover, keyboard focus
  and touch: Rename…, New conversation, Open details, Remove. Right-click opens the same
  menu. Status marks sit on the avatar's bottom-end corner: working (8px `success` dot, still;
  the face carries the motion), needs you (8px `warning` dot).
- Render the list virtualized with fixed 54px rows; 2,000 bots must scroll at 120fps.
- **Footer** (60px: 8px top, 16px bottom and sides): profile button (36px avatar + the
  person's name 14/20/500, 8px apart) at the start; at the end two 36px elevated controls 8px
  apart: **Plugins** (`apps` 16px), opening the Marketplace page, and **Workspace**
  (`settings` 16px), opening the workspace panel.
- Empty (no bots): one line "No bots in this space yet." and a pill "New bot…".
- Loading: keep the header; reserve rows; show a spinner only after 300ms.
- Error: inline row "Couldn't load bots." + text button "Try again".

## 7. Chat

### 7.1 Header pill

Centred 10px from the top, 41px tall, `composer` fill, 1px ring of `ink` at 6%, full
radius. Two halves, each its own round button with padding 9px top, 8px bottom, 9px start,
11px end inside the ring and a hover fill of `composer` mixed 7% toward `ink`: the bot's
avatar 22 and name 14/20/500, 8px apart; then, in an agent chat, a 1px × 16px divider of
`ink` at 12% and the model's mark 14, its name 13/400 `ink_secondary` and `chevron-down` 14
`ink_tertiary`, 4px apart. Clicking the model
opens its picker (`pop`, 4px down from the pill; the chevron turns 180° in `slide` and the half
keeps its hover fill while open). After a choice the model label fades in from 40% (`fade`) and
the bot's faces in the conversation blink once. Clicking the bot name opens the side panel.
The face in the pill turns toward the pointer; states and focus of both halves are in §3.6.

The Details tab's **Model** row uses the same picker. Its trigger is a quiet pill at the row's
end: 28 tall, padding 10 / 8, full radius, mark 14, name 13 (`ink` once chosen,
`ink_secondary` for "Choose a model"), `chevron-down` 14; no fill at rest, `ink` 6% on hover and
while open; the menu opens below it, aligned to its end.
No other header buttons. On Windows and Linux a 138px spacer on each side keeps the pill
clear of the caption buttons; macOS has none.

### 7.2 Transcript

- Column max 960 inside 20px padding plus the reference's 8px scrollbar gutter at the end
  (28px), bubbles max `min(560, 80% column, column − 82)`.
- Bot bubbles start-aligned, `card` fill, `ink` text. The person's bubbles end-aligned,
  `bubble_user` fill and ink (neutral grey in Midnight, near-black in Daylight).
- Bubble: radius 18, padding 7px block / 12px inline, text 15/22, min width 36.
- Rows 16px apart. Consecutive bubbles from the same side join: 4px apart, and the joined
  corners on the speaker's side tighten to 6.
- Markdown in bot bubbles: paragraphs 8px apart; inline code Geist Mono 13 on `ink` 8%,
  radius 4; code blocks, tables and quotes are drawn with no fill of their own: 1px
  `hairline`, `ink` 3% tint, radius 12, horizontal scroll inside, a Copy icon button at the
  top end on hover/focus. Links `accent_text`, underline on hover.
- Long person messages (over 12 lines) clamp with a fade and "Show full message".
- Day separators: centred 12/400 `ink_tertiary` ("Today", "Yesterday", "Mon 17 Nov").
- Hover on a bubble (also on focus) shows a 28px action strip under it: Copy, and for bot
  messages Retry (Planned).
- `Message.role` values other than `user` and `bot`/`assistant` render as a centred 12px
  `ink_tertiary` line, never as a bubble.
- Scrolling: stick to the bottom while the person is at the bottom; otherwise show a 32px
  round "Jump to latest" button (`arrow-down`) 12px above the composer.
- Use a virtualized list with variable heights; never re-layout the whole transcript on a
  streaming event.

### 7.3 Working row

While a run is active (from `run.started` until `run.finished`/`run.failed`; until the
event catalogue exists: between a `send_message` receipt and the next bot message for its
`run_id`), a 38px row sits directly above the composer clearance: the bot's 20px avatar
and "Working…" 13/400 `ink_secondary` with a soft left-to-right shimmer (1.6s loop; static
under reduced motion). It replaces no content and reserves its slot so nothing jumps.

### 7.4 Composer

- Floating pill, column width, 44px tall on one line, `composer` fill, 1px ring of `ink`
  at 10%, radius 22 (18 once it wraps to two lines), padding 7px top / 9px sides and bottom
  inside the ring, shadows `0 2 8 −1 rgba(0,0,0,0.05)`, `0 1 2 rgba(0,0,0,0.03)` and
  `0 0 0 1 rgba(228,228,228,0.04)`. Ring goes
  to `ink` 22% when the pointer is over the composer or the text field has focus.
- Contents: `+` (28px round, `ink` 4% fill and ring, a 20px plus of stroke 2 in
  `ink_tertiary`; opens Attach file… [`artifacts/create` is Live; screen To build]);
  multi-line field 14/20 with 4px block and 2px inline padding, 6px after the `+`, `dir`
  auto, placeholder "Message {bot name}" in `ink_secondary`, grows to 40% of window height then scrolls; a mic
  28px (Planned, hidden); the round 28px **Send** button in the bot's identity colour with
  `arrow-up` in its ink. While the field is blank, Send stays in the bot's colour but quiet
  (fill identity α 0.14, arrow identity α 0.55, not a Tab stop), and fills in `hover` time when
  text arrives; in a group the identity is `ink`. The composer's height follows its text in
  `grow`.
- Send is disabled (50% opacity) when the field is blank or over 100,000 UTF-16 units
  (`InvalidMessage`); over the limit, a 12px `danger` count shows at the field's end.
- Enter sends, Shift+Enter breaks a line, IME composition never sends. Up arrow in an
  empty field recalls the last message for editing (local only).
- On send: insert the person's bubble at once (optimistic, 60% opacity until the receipt
  arrives); on error the bubble gets a 14px `danger` `circle-alert` and "Couldn't send.
  Retry" text button under it. Draft text survives switching bots (per bot, in memory).
- Bottom clearance: transcript bottom padding = composer height + 54px.

### 7.5 Live connection

`subscribe(space, agent, cursor)` from the last `seq` seen. Retry with backoff
(1s, 2s, 5s, 10s, then every 30s) on `is_retryable()`. After 5s offline, a 28px pill
appears above the composer: "Reconnecting…" (`wifi-off` 14px); it disappears on resume
without a "back online" toast. `is_unauthorized()` → sign in. Never duplicate a message
already shown: key rows by `id`, order by `seq`.

### 7.6 Question cards (Live)

A run that waits on the person puts a card in the transcript.
Start-aligned, `composer` fill, radius 18, 440px wide. Answered with `threads/answer`.

- Typed question: the text, any detail, a field "Your answer" and **Send** (Enter sends).
  Answered: the reply as a quote under a 2px `hairline` rule.
- Options: lettered rows A–D, 36px, hover `raised`; one click sends the option id. Answered:
  the chosen row keeps `raised` and a check, the card dims to 70%.
- Secret (`input: secret`, not a login, card or contact): key glyph, the destination
  (site, `Command variable $NAME`, or "Only enter a code {host} sent you."), a masked field
  named by its purpose, **Send**, and a quiet **Dismiss** beside "Saved for this agent. It
  never appears in the chat." The value is read once on send; the field is dropped with
  everything it held. Failures never show the server's words, except the vault's two
  fixed refusals. Settled: "Saved", "Sent", "Dismissed" or "Expired".
- First-run focus choice (`choice`): lettered rows and a close button, answered with
  `onboarding/choose` or `onboarding/dismissFocus`.
- Only the run's own user answers: anyone else sees "Only the person who started this run
  can answer it." with no controls. A run no longer waiting reads "No longer waiting for
  an answer." A stale answer says "This question isn't waiting for an answer anymore. It
  may have been answered somewhere else." Waiting runs come from the snapshot's
  `activeRuns`, so a card pending before a restart is answerable after it.
- Approvals (Allow once / Deny), login, card and contact forms, and tool questions keep
  their existing cards; the last three open in the web app.

### 7.7 Empty and error states

- New conversation: the bot's 64px avatar, its name 20/600 and one line 15/22
  `ink_secondary` "What should {name} do?", centred 30% from the top; the composer stays
  where it always is. The face follows the pointer anywhere in the chat area and looks down
  toward the composer while the focused field holds text.
- History failed: inline card in the column, "Couldn't load this conversation." + "Try
  again".

## 8. Agent side panel

The panel docks on the right. Click the avatar to choose its shape and colour, the name to
rename the bot, or the gear to edit instructions, job and notifications.

- **Details** lets members select a model and create, switch, rename, pin or archive additional conversations.
- **Library** lists files, pages and apps referenced by the open conversation.
- **Computer** opens the agent's computer and its screen controls when enabled on the host.
- **Inbox** shows the current member's questions, work in progress and results for this bot.

The store manages access to installed plugins per bot.

## 9. Marketplace page

Opened from the sidebar Store button or `Cmd/Ctrl+Shift+P`. Uses the page frame (§4).

```
‹  Store                                                      [ My plugins ]  [ New plugin… ]
   ( ⌕  Search plugins                                   )
   (All) (Skills) (Tools) (Installed)

   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ ▣ Release…   │ │ ▣ Tracker    │ │ ▣ …          │
   │ release-notes│ │ tracker · v3 │ │              │
   │ Draft rele…  │ │ …            │ │              │
   │ [Skill][Tool]│ │ [Tool]       │ │              │
   │        Install│ │   Installed ✓│ │              │
   └──────────────┘ └──────────────┘ └──────────────┘
```

- Title "Store" 26/600. Header end: "My plugins" (pill: the `mine` list from §10, which
  ships read-only before the creator) and, once §10 ships, "New plugin…" (ink primary
  pill). Until then the slot holds a quiet "Publish a plugin" link that opens the
  developer docs in the browser.
- Search field: 36px, full radius, `control` at 70%, `search` 15px, text 14. Filters as
  32px pills; the selected pill is `ink` fill with `app` text, others 1px `hairline`.
  "Skills" = has a `skill` part, "Tools" = has an `mcp` part, "Installed" = from
  `installations`.
- Grid: 3 columns at ≥ 960px content width, 2 at ≥ 600, 1 below; 16px gaps. Card: `card`
  fill, radius 12, 16px padding, no border, no shadow, hover `raised`. Inside: a 40px
  monogram tile (radius 8, `control` fill, first letter of the name 17/600 `ink`; the only
  plate allowed besides avatars because plugins have no image), name 13/500, `slug · v{n}`
  12/400 Geist Mono `ink_tertiary`, description 13/18 `ink_secondary` clamped to 2 lines,
  part chips (24px, full radius, `control`, 12/400: "Skill", "Tool"), and at the bottom end
  "Install" (28px pill, 1px `hairline`) or "Installed" with `check` 14 in `ink_secondary`.
- Paging: `discover` with `limit: 50` (the maximum); load the next page when the last row nears view.
- Card click opens the plugin in the side panel (§9.1). The Store page stays behind it.
- Empty search: "No plugins match “{query}”." Empty registry: "No plugins published yet."
  - "Publish a plugin". Error: inline "Couldn't load the store." + "Try again". Signed-out
    or expired session (HTTP 401): back to sign in (§5).

### 9.1 Plugin details (side panel)

- Header: monogram 56, name 20/600, `slug · v{n} · approved {date}` 12 Geist Mono.
- Description 13/18 `ink`.
- "What it adds" group label, then one row per part: `book-open` (skill) or `plug` (tool)
  16px, part id in Geist Mono 13, and for tools the endpoint host 12 `ink_tertiary`.
  "Show instructions" disclosure reveals skill Markdown read-only (max 320px, scrolls).
- Trust line, 12 `ink_tertiary`, always shown: "Skills are instructions a bot reads. Tools
  run on {host}, not on this computer." (Security invariant: skills are untrusted input and
  tools are remote; the UI must never imply otherwise.)
- Primary: **Install** (ink pill, 32px). Idempotent; while pending "Installing…".
- After install, the panel shows **Give to bots**: one row per bot (avatar 24, name), and
  under it a switch per part. Toggling calls `setGrants(installationId, botId, partIds)`
  with that bot's whole selection. New installs start with zero grants: the list is open
  by default so the person sees nothing runs until they switch it on. No dialog.
- **Uninstall** is a text button in `danger` at the panel's bottom. It removes every
  grant in the Space at once, then shows a toast "Uninstalled {name}." with **Undo** for
  6s (Undo installs the same `versionId` again and re-sends each bot's previous grants).
  Undo creates fresh grants: approvals that were waiting on the old ones stay void, by
  design of the runtime (a re-added grant gets a new identity).
- When multiple releases are approved, show a version selector. Switching an installation
  asks for confirmation that its previous bot grants will be cleared. Submit the selected
  release and current pin together through `pluginRegistry.switchVersion`. A failed switch
  preserves the pin and grants. After a successful switch the member chooses new grants.
- Install, grants and uninstall act on the selected Space. With more than one Space,
  the panel's header shows "In {space name}" 12 `ink_tertiary`.

### 9.2 Tool approval card (in the chat)

The runtime asks a person before **every** call to a plugin's remote tool, and refuses
new calls in a Space set to **Never ask**. This is a security invariant, so it is the one
ask the design keeps. It arrives as a pending approval in the bot's conversation and is
answered with `threads/answer`.

```
 ╭──────────────────────────────────────────────────────────╮
 │ ⊙ Scout wants to use convert_temperature                  │
 │   Unit converter · units.example.com                      │
 │   ┌──────────────────────────────────────────────────┐    │
 │   │ { "value": 100, "from": "celsius", ... }          │    │
 │   └──────────────────────────────────────────────────┘    │
 │                                   ( Deny )  ( Allow once )│
 ╰──────────────────────────────────────────────────────────╯
```

- Start-aligned like a bot bubble, `card` fill, radius 18, 14px padding, max width
  `min(560, 88% column)`. Not a dialog; it never blocks the composer.
- Line 1: the bot's 20px avatar, "{Bot} wants to use {tool name}" 14/500.
- Line 2: plugin name, a middot, the endpoint **host** in Geist Mono 12 `ink_tertiary`.
  The full endpoint is in the tooltip. Always shown: a person must see where data goes.
- Arguments: the exact JSON the runtime will send, Geist Mono 12/18 on `inset`, radius 12,
  clamped to 8 lines with "Show all" (never truncated silently; the card scrolls inside
  past 320px).
- Buttons at the end: **Deny** (quiet pill, 28px) and **Allow once** (28px pill in the
  bot's identity colour). Keyboard: focus lands on Deny when the card is reached by Tab,
  so a stray Enter never sends data. No "Always allow" (the runtime has none).
- After an answer the card collapses to one 12px `ink_tertiary` line: "Allowed
  convert_temperature · 14:02" or "Denied … · 14:02".
- Grant removed while waiting: the card dims to 60% and reads "This tool is no longer
  granted to {Bot}." with no buttons (the runtime would refuse it).
- Never ask Space: no card; the bot's reply explains the refusal in its own words.
- Several pending at once stack in arrival order; each answers independently.

## 10. Plugin creator page

The store opens a form for skills, connectors and apps. It submits a version and displays the
result in Yours. The CLI operates on a local `plugin.json` with the same schema. The
preview column, footer bar and slug availability check below are planned.
The registry checks MCP endpoint safety during approval.

Opened from "New plugin…" or "My plugins" → a plugin → "New version…". Two columns at
≥ 1100px content width (form 1fr, preview 420px); stacked below.

**Form column**

1. Name (field, 1–120 chars), Slug (Geist Mono, auto-derived from the name until edited;
   1–64 chars matching `^[a-z0-9]+(-[a-z0-9]+)*$`; check availability against `mine`/`discover` on
   blur; a reserved slug says "That name is taken. Try another."), Description (multi-line,
   3 rows, 1–1,000 chars).
2. "Parts" group label with an "Add part" pill menu: **Skill** / **Tool (MCP)**.
   1–16 parts; at 16 the pill is disabled with the tooltip "A plugin can have 16 parts."
   Each part is a card (`card`, radius 12, 16px padding; no nested cards):
   - Header row: kind icon, editable part id (Geist Mono, lowercase, unique), a
     `trash-2` icon button at the end (removal offers Undo).
   - Skill: Markdown editor, Geist Mono 13/20, min 8 rows, `inset` fill, radius 8;
     1–16,000 chars, a 12px tabular count appears from 90%.
   - Tool: Endpoint field (`https://…`), transport fixed to "Streamable HTTP" shown as a
     value, not a control.
   - App (Live): a form people fill in to keep records. One row per field (1–16) under
     a single column header "Label · Identifier · Type · Required": label field (≤120
     chars), identifier field (slug pattern, unique in the app), Text / Number / Date
     chips, a Required checkbox, and `x` when more than one field remains; "Add field"
     below. Once a number field exists, a "Total" chip row offers None or each number
     field by label. Changing that field's type or removing it resets Total to None.
3. Version: a read-only value "Version {n}" (next integer for this slug).

Inline validation, each message under its field, in `danger` 12px:

- part ids not unique, or not matching the slug pattern (parts share it);
- endpoint not `https`, or carrying credentials, a query string or a fragment, or a
  localhost/private address: "Use a public HTTPS address without keys, tokens or a ?query.";
- the manifest accepts no credentials, headers, commands, packages or hooks, so the
  creator offers no fields for them; pasting JSON that contains them shows
  "Superbot plugins can't carry secrets or commands. Remove “{field}”."

**Preview column** (sticky): "Manifest" label, read-only JSON (schema 1) in Geist Mono
12/18, `inset` fill, radius 12, with Copy. It updates as the form changes. Under it an
"Open plugin.json…" text button that fills the form from a file (validated the same way).

**File round trip** (To build). The header carries two quiet pills before Submit for review:
"Open file…" and "Save file…", both through the system file dialogs. Validation follows the
same manifest rules as `superbot-plugin`, so limits, trimming and endpoint rules match the
registry, and saved bytes match the CLI.

- Open reads the whole file before touching the form. Another schema version, a part
  kind other than skill, mcp or app, a field type other than text, number or date,
  another transport, or any extra field is refused with
  one line naming it (secrets and commands use the copy above); the form is unchanged.
  Values over the limits load, with "Fix this before submitting: …" in the error line.
  Name, description and parts are replaced; identifier and version never are, so a new
  version keeps its locked slug. With unsaved edits, an inline row asks "Replace this
  form with {file}? Your edits here aren't saved." with Replace and Keep editing.
- Save offers `plugin.json` beside the last file, and the system dialog confirms any
  overwrite. The bytes go to a temporary file in the same folder that is then moved
  over the target, so a failed write never leaves half a manifest. A ready manifest is
  written exactly as the CLI writes it; an unfinished one is written as typed, with
  "Saved as a draft. Fix this before submitting: …".
- Under the header, 12 `ink_tertiary`: a file glyph, the path, and "· Opened", "· Saved"
  or "· Edited". Hidden until a file is attached.

**Footer bar** (planned; sticky, 64px, 1px `hairline` on top, `app` fill): start: the file path
12 `ink_tertiary` and "Saved" once written (drafts are local files, never sent until
submit); end:
**Submit for review** (ink pill). After submit the page shows the version in **My plugins**
with status.

**My plugins** list (a section of the creator page, from `mine`): 48px rows with name,
`v{n}`, and a status chip: Pending (`ink_secondary` on `control`), Approved (`success`
text), Rejected (`danger` text) with the reviewer's reason under the row in 12
`ink_secondary`. Rejected slugs stay reserved: "New version…" is offered, never
"Delete". Versions are immutable: no edit on a submitted version.

## 11. Review queue for deployment admins

Today: `superbot-plugin list submissions` and `superbot-plugin review`. In the app: only
listed in the profile menu when the account is a deployment admin (an account in the
server's `SUPERBOT_ADMIN_EMAILS`). The server enforces it with HTTP 403; the UI hides the
entry but never relies on hiding. Show the server's reason inline if a review returns 403. A list of pending
submissions (`submissions`), 56px rows: name, `slug · v{n}`, publisher, submitted date.
Selecting one opens it in the side panel with the same Plugin details layout plus the full
manifest JSON and two buttons: **Approve** (ink pill) and **Reject…** which reveals an
inline reason field (required, 1–2,000 chars) and **Reject** in `danger`. A version can be
decided once; afterwards the row leaves the queue and a toast confirms. No Undo here
(the server has none); this is the one place that says so: "Decisions can't be changed."

## 12. Multiplayer (server Live; presence and typing Planned)

What is live: several accounts share a Space. The owner invites people by single-use
link (always) or by email (when the server has SMTP); a link brings in one account and
expires after 7 days. Members see the Space's bots and conversations; only owners manage
members and create invites (a member creating an invite gets HTTP 403). Removing a member
revokes access at once. Group conversations hold several bots.

### 12.1 Space menu and members panel

- The Space switcher (§6) shows a 14px `users` mark after a shared Space's name. Its menu
  ends with "Members" and, for owners, "Invite people…"; then "Leave space" for members.
- **Members** opens the side panel: 44px rows with avatar 28, name 13/500, email 12
  `ink_tertiary`, role meta at the end ("Owner", "Member"). Owners get a row `⋯` menu
  with "Remove from space". Removal cannot be undone by the server, so the toast offers
  "Copy new invite link" instead of Undo. The person's own row reads "You".
- **Invite people…** (owners only; hidden otherwise, enforced by the server) opens a
  sheet in the panel: "Copy invite link" (ink pill; creates the link, copies it with the
  system clipboard, then shows "Link copied. It works once and expires in 7 days.") and
  an email field + "Send invite" only once the client can tell that the server has mail
  set up (ask the client owners for that flag; until then show the link flow only). Pending
  invites list under it (12px, created date) with "Cancel" text buttons. Invite links
  are secrets: never show them in full in the UI, never log them.

### 12.2 Joining

"Join a space…" (New menu) opens a small dialog (420 wide) with one field "Invite link".
On paste: preview with `spaces/invites/preview` and show the Space name and who invited
("Join Design team, invited by Ada"). **Join space** accepts; errors inline: used or
cancelled link → "This invite was already used or cancelled. Ask for a new one.";
expired → "This invite expired. Ask for a new one." After joining, the new Space is
selected. An `superbot://` link handler is Planned; do not register one yet.

### 12.3 Conversation with people and bots

- **Transcript**: every bubble not from me is start-aligned. Above the first bubble of a
  run: speaker name 13/600 in the bot's identity colour (bots) or `ink_secondary`
  (people), inset 12px to line up with the bubble's text, 4px above it, with no avatar.
  Bubbles not from me use `card`. My bubbles stay end-aligned with no
  name. A member joining or leaving is a centred 12px `ink_tertiary` line.
- **Group conversations**: the header pill shows up to 3 overlapping 24px bot avatars
  (2px `panel` ring) and the group's name. `@` in the composer opens a 30px-row menu of
  the group's bots (avatar 20, name); the mention renders as a 13/500 inline token in
  `accent_text`. Placeholder: "Message {group}, @ to ask one bot".
- **Approvals in shared Spaces**: the approval card (§9.2) shows to whoever is in the
  conversation; after an answer the collapsed line adds who answered ("Allowed by Ada")
  when the answer event carries the person (part of §0 ask 2).
- **Presence and typing** (Planned, needs §0 ask 4): up to 3 overlapping 20px avatars of
  people currently viewing at the end of the header pill; "{Name} is typing…" in the
  working-row slot. Not shipped until the events exist.

## 13. Command palette and keys

`Cmd/Ctrl+K` opens a 640-wide palette 15% from the top (`menu` surface, radius 12,
`pop` motion): a 44px search field, then grouped results (Bots, Conversations, Plugins,
Actions), 36px rows, `ShortcutHint` keycaps at row end. Arrow keys, Home/End, Enter,
Escape, type-ahead.

| Action                    | macOS     | Windows/Linux  |
| ------------------------- | --------- | -------------- |
| Search / palette          | ⌘K        | Ctrl+K         |
| New… menu                 | ⌘N        | Ctrl+N         |
| Toggle sidebar            | ⌘\        | Ctrl+\         |
| Store                     | ⇧⌘P       | Ctrl+Shift+P   |
| Next / previous bot       | ⌥⌘↓ / ⌥⌘↑ | Ctrl+Alt+↓ / ↑ |
| Focus composer            | ⌘L        | Ctrl+L         |
| Close page, panel or menu | Esc       | Esc            |
| Settings                  | ⌘,        | Ctrl+,         |

Define them in a single keymap module so the palette can list them.

## 14. Settings (dialog)

A 680×560 dialog (radius 14, `menu` surface) with a 180px start nav: General (Theme ·
System/Midnight/Daylight; Language), Account (server, email, Sign out), About (version,
licences: the OpenMausBot Apache-2.0 notice for the icon and tokens, Lucide ISC,
Geist OFL 1.1, bundled with the app as in `NOTICE.txt`). Rows 44px, value-first ("Theme · System").
No new toggles.

## 15. Accessibility

- Focus: every interactive element is focusable, has a visible 2px `focus` ring after
  keyboard input (outside with a 2px gap, or inside in lists and containers, §3.6; menu rows
  show focus as their hover fill; text fields as their ring and caret), and is reachable with
  Tab in reading order. Never trap Tab except in dialogs; Escape returns focus to the opener.
- Hover-only controls (row `⋯`, bubble actions, Copy) also show on keyboard focus.
- Contrast: text 4.5:1, focus ring and control edges 3:1 on every surface, both skins.
- Right-to-left: mirror the shell (sidebar on the end side) and directional icons.

## 16. Acceptance checklist per screen

- [ ] Only `Theme` tokens, this type table, this radius scale.
- [ ] Midnight and Daylight; 1440×900 and 760×520; long names (60 chars), emoji, Arabic.
- [ ] Default, hover, focus, pressed, disabled, loading, empty, error, offline.
- [ ] Keyboard-only path through the whole flow.
- [ ] Reduced motion: no animation.
- [ ] Planned features absent, not teased.
- [ ] Screenshots use invented data.
