# ui-parity, phase 1: bot look and feel

Goal: bots in Superbot look and feel like the reference bot app (named in the task brief; its
name is kept out of product code and copy) on web and in the Electron desktop app on Windows,
macOS and Linux. Phase 1 collects public references, captures Superbot's current state,
compares them side by side, and ships the first alignment slice: the shared bot avatar.

Nothing here was copied, downloaded from, decompiled or traced from the reference app. Avatar
geometry is Superbot's own (the eight outlines already lived in
`packages/core/src/avatars/bot-avatar-shapes.ts` before this work); phase 1 changes the face and
how the avatar is drawn and moves.

## Public references used

All screenshots below are public images, read on 2026-11-23. Crops in `side-by-side/` keep only
the part a comparison needs and leave out the vendor's logo and wordmark, third-party logos and
personal names. **Third-party images in a public repo: the owner should confirm before this
reaches `main`.** The full reference images are not committed.

| Ref | Source | Date | Shows |
| --- | --- | --- | --- |
| R1 | flaviocopes.com/grok-bot, image `create-first-bot.jpg` | page updated 2026-11-19 | new-bot screen: large avatar, 10-colour palette, 8 shapes, suggestion cards |
| R2 | flaviocopes.com/grok-bot, image `blog-pulse-first-run.jpg` | 2026-11-19 | thread, composer, working avatar under the reply, roster row with green working dot |
| R3 | flaviocopes.com/grok-bot, image `update-old-posts-bot.jpg` | 2026-11-19 | roster sections, task cards with Done pill, composer |
| R4 | flaviocopes.com/grok-bot, image `daily-routine.jpg` | 2026-11-19 | event row "Created routine", file card, routine settings panel |
| R5 | flaviocopes.com/grok-bot, image `product-page.jpg` (the vendor's product page) | 2026-11-19 | roster with 7 bots, group thread, inline bot mentions |
| T1 | x.ai/news/designing-grok-bot (text) | 2026-09-03 | avatar states: idle, thinking, working, waiting, blocked, done; hover shows current action |
| T2 | docs.x.ai/grok-bot/approvals-security-and-privacy (text) | undated, read 2026-11-23 | approval card buttons and labels |
| T3 | docs.x.ai/grok-bot/bots, /chat-and-collaboration (text) | undated, read 2026-11-23 | create flow, avatar editor, composer controls |

Not found as a public image: an approval card, the main Settings screen, and any still or video
of the avatar's thinking, waiting, blocked, done or hover motion (T1 has a figure titled "Avatar
motion system", but its images could not be read). These are listed as gaps; the owner may supply
screenshots.

## Avatar: what was matched

Shapes (Superbot key → reference form, from R1 and R5):

| Superbot shape | Reference form |
| --- | --- |
| `blob` | circle |
| `pebble` | wide rounded pebble |
| `squircle` | rounded square |
| `tablet` | pill |
| `wedge` | rounded triangle |
| `hex` | rounded hexagon |
| `cloud` | cloud |
| `teardrop` | drop |

Face (R1, R5): two short rounded dashes, leaning clockwise, set a little above and right of the
middle. Superbot's shared eyes are now 19×44 units (were 15×52), shifted right and up, slanted
14°. The ten reference colours already match Superbot's palette (brown, red, orange, amber,
green, teal, blue, purple, pink, grey).

Style: flat. The drop shadow (idle) and coloured glow (working) are gone.

3D: the flat body is extruded into a solid. Approach chosen: **SVG + CSS**, no WebGL and no new
dependency. One registered angle (`--rakazo-mascot-turn`) drives the turn: the face narrows by
its cosine and six stacked copies of the body behind it slide out by its sine, darkened, which is
how an extruded shape looks turning about its vertical axis. At 0° the copies sit exactly behind
the face, so a still avatar is the flat 2D shape. Why not three.js/WebGL: the shapes are prisms
turning about one axis, which this draws exactly; a 3D library would add a dynamically loaded
package, a WebGL context per avatar (roster rows, chat, pickers) and a separate fallback, for no
visible gain at 20–56 px. Startup CSS grows by about 3 kB; the web startup bundle is 884.1 kB of
its 900 kB budget.

Motion (every motion includes a turn):

| State | Reference | Superbot |
| --- | --- | --- |
| idle | R5 roster, R1 (image) | flat, still, facing forward |
| working | R2 (image: avatar under the reply, green roster dot), T1 | turns ±34° while the body bobs |
| thinking | T1 (text only) | slow look left and right (±20°) |
| waiting | T1 (text only) | rests, then nudges towards you |
| blocked | T1 (text only) | short shake, then still |
| done | T1 (text only) | one settling turn when work ends |
| hover | T1 (text only) | an idle bot turns towards the pointer |

Fallbacks: `prefers-reduced-motion` keeps the flat shape facing forward with no motion; a
browser without CSS trigonometry draws the flat shape; offscreen and hidden avatars pause.
WebGL is not used, so there is no WebGL fallback to need. One shared component
(`BotAvatar` in `packages/ui-web`) draws the avatar everywhere a shape or default avatar appears
(roster, chat, group avatars, pickers, settings); colours and accessible names are unchanged.
Photo avatars and the optional "Rakazo" avatar style are unchanged.

## Files

`side-by-side/` (Superbot | reference):

| File | Shows |
| --- | --- |
| `01-avatar-shapes.png` | the eight shapes, after and before, next to R1 |
| `02-avatar-picker-and-palette.png` | every state grid next to R1's preview, palette and shapes |
| `03-avatar-state-idle.png` | idle row next to R5's roster |
| `04-avatar-state-working.png` | working row (after, before) next to R2 |
| `05-avatar-state-thinking.png` | thinking row; reference is text only |
| `06-avatar-state-waiting.png` | waiting row; reference is text only |
| `07-avatar-state-blocked.png` | blocked row; reference is text only |
| `08-avatar-state-done.png` | frame of the settling turn; reference is text only |
| `09-avatar-state-hover.png` | hovered bot turning; reference is text only |
| `10-chat-thread.png` | Superbot thread (harness) next to R5's thread |
| `11-roster-and-header.png` | Superbot roster next to R5's roster |
| `12-composer.png` | Superbot composer next to R3's |
| `13-task-progress-cards.png` | gallery task cards next to R3's Done card |
| `14-working-indicator.png` | gallery "Working…" row next to R2's avatar-only indicator |
| `15-widgets-and-event-rows.png` | gallery checklist, reminder row and table next to R4 |
| `16-approval-card.png` | gallery approval cards; reference is text only (T2) |
| `17-settings.png` | Superbot settings next to R4's routine panel (no public main Settings image) |

`web/` (captured on this host, headless Chrome, fixture data):

| File | Shows |
| --- | --- |
| `before-avatar-states-{light,dark}.png` | avatar states fixture on the base commit: glow, upright eyes, every state the same |
| `after-avatar-states-{light,dark}.png` | same fixture after: flat, slanted eyes, each state turning its own way (frames mid-motion) |
| `after-avatar-states-28px.png` | the same at sidebar size |
| `after-avatar-states-reduced-motion.png` | reduced motion: every avatar flat and facing forward |
| `after-avatar-hover-{light,dark}.png` | the idle row with one bot hovered |
| `after-avatar-done-{light,dark}.png` | the done row mid-settle |
| `after-avatar-states-{light,dark}.webm` | 6 s recordings of every state, hover and done (no audio) |
| `harness-bot-avatar-states.png` | the e2e harness's capture of the fixture (animations frozen, so flat) |
| `after-chat-surface-{light,dark}.png` | real app through the e2e harness: roster, thread, composer |
| `after-settings-surface-{light,dark}.png` | real app: Settings → General |
| `after-group-avatar-active.png` | group-chats e2e: group avatar with one working member |
| `before-gallery-{conversation,approvals,working,routines}-light.png` | chat gallery fixture (these screens are unchanged by phase 1) |

`web/ci-<os>-chromium-bot-avatar-states.png`: the same e2e capture taken by CI in Chromium on that OS.

`evidence/local-test-results.png`: the local test runs listed below, rendered as an image.

`linux-desktop/`, `windows-desktop/`, `macos-desktop/`: `ci-electron-bot-avatar-states.png` is the avatar fixture opened inside the Electron desktop window by `apps/desktop/e2e/bot-avatar.spec.ts` (live frames, so avatars are caught mid-turn), and `ci-electron-bot-avatar-states-reduced-motion.png` the same window with reduced motion (all flat). Taken in CI, see below.

## Gaps, per surface, ranked by visual impact

Chat thread
1. User bubble colour: Superbot tints the user's bubble with the bot's colour (orange in
   `10-chat-thread.png`); the reference is always ink. This is a deliberate upstream feature
   (e2e `chat-bubble-colors`), so it is the owner's call.
2. Header: the reference puts avatar and name at the left on a hairline bar with a computer
   button at the right; Superbot floats a centred name pill with a call button.
3. Width: reference bot bubbles run wider (up to ~75% of the pane); Superbot's fit their text.

Avatar
1. New bots default to Superbot's own organic blobs (`DEFAULT_NEW_BOT_AVATAR_SET = "organic"`),
   not the eight shapes. Switching the default is a product decision for the owner.
2. Idle "curious" eye movement (eyes look around; R1's large preview has them low-left): not done.
3. Accessories (R5: a red dot on one bot) and the "controlled variations" T1 mentions: not done.
4. Hover shows the bot's current action (T1): only the turn is done.
5. Eye colour: Superbot keeps dark eyes on light bodies (green, teal) for contrast; the reference
   uses white eyes on every colour shown.

Composer
1. The reference shows one filled ink mic button when empty and no send button; Superbot shows an
   outlined mic plus a disabled send circle.

Roster
1. The reference keeps a search field at the top; Superbot has a search icon.
2. The reference lists bots without a "Personal" section header in its default view.

Task and progress updates
1. Status pill: the reference uses a dot plus sentence-case label ("● Done") on a light tint;
   Superbot's pills are lowercase text ("finished", "running") without a dot.
2. Working indicator: the reference shows only the moving avatar under the last message (T1
   says three dots were rejected and the avatar's motion is the signal); Superbot shows the
   avatar plus "Working…".

Widgets and event rows
1. Event rows: the reference sets an icon and the routine name in ink ("Created routine ⏱ Daily
   blog review"); Superbot's rows are all grey with the name in quotes.

Approval card
1. No public image. The documented buttons (Allow once / Always allow / Deny) match Superbot's.

Settings
1. No public image of the main Settings screen; nothing to compare yet.

## Conflicts with the repository rules (for the owner)

- The extrusion's side is the bot colour mixed with `black` in CSS (`color-mix`). It is a shade
  of the identity colour, not a new product colour, but it is a colour keyword outside the token
  file.
- Eye contrast (gap 5 above) and the tinted user bubble (chat gap 1) are existing product rules
  the reference does not follow. Neither was changed.
- The fork's own theme (`infra/superbot/theme/theme.json` on the `superbot` branch) carries a
  `userBubbleTint` field that main's instance-theme loader rejects ("not a theme field"), so on
  main the whole theme is ignored. The ink user bubble could be offered through the instance theme
  once main supports such a field.

## Mobile (Expo)

Not changed on purpose, apart from what comes through shared code: shape avatars on mobile pick up
the new eye size and position from `packages/core`. Mobile does not slant the eyes, extrude or
turn; it keeps its own Reanimated motion. A native version would draw the same slices with
`react-native-svg` and drive the angle with a Reanimated shared value (cos/sin in a worklet),
with `AccessibilityInfo.isReduceMotionEnabled` for the still fallback. Mobile screenshots were
not captured: `pnpm ios:screenshots` needs macOS, and `pnpm test:mobile-screenshots` was not run in
phase 1.

## What was tested where

On this host (NixOS, headless Chrome):
- Unit: `packages/core` avatars (motion mapping, notification portrait), `packages/ui-web`
  avatar tests (each state, extrusion, settle, reduced motion), mobile avatar and group-seat tests:
  all passing.
- Web e2e through the harness (`pnpm test:e2e`): `bot-avatar-states`, `avatar-motion`,
  `group-chats`, `gallery` and the new `bot-chat-surface` spec. 22 passed, 1 failed:
  `gallery › tool's question as plain text with its form`, whose `getByText("This call")`
  matches two elements of the approvals card; phase 1 does not touch that card, and the test
  also fails with the base versions of every file this change touches restored.
- Typecheck of core, ui-web, web and desktop; Biome; `pnpm checks`; web build and the startup
  bundle budget (884.1 of 900 kB).
- Linux desktop: not run on this host; covered in CI below.

In CI (GitHub Actions on the fork, cross-platform workflow, job "Bot avatar" on ubuntu, windows
and macos): see `linux-desktop/`, `windows-desktop/`, `macos-desktop/` and the run linked below.

Gaps: macOS and Windows desktop cannot run on this NixOS host; they are covered only by CI.
