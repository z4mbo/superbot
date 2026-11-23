# Superbot avatars

Bot avatars for the native apps. Without a pack every bot shows the built-in face (a disc in
its identity colour with two eyes). A person can install a **local avatar pack** on their own
computer; bots are then drawn as the pack's shapes: still at rest, turning toward the pointer
over their row, tile or header pill, and moving while they work. Their chats can take the
bot's colour too.

Packs are personal files. The app never bundles, downloads or uploads one, and nothing in this
repository is a pack.

## Where the app looks

`avatars/pack.json` inside the appearance folder:

| System  | Folder                                                    |
| ------- | --------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Superbot\appearance`                      |
| macOS   | `~/Library/Application Support/Superbot/appearance`       |
| Any     | `SUPERBOT_APPEARANCE`, when set (fixtures and tests)      |

Every path inside a pack is relative to `avatars/`, so the folder can be copied between
computers as it is. A missing pack is normal; a broken one is reported on stderr and ignored,
and so is a shape whose frames file cannot be read. The pack is read once at start.

## `pack.json`

```json
{
  "version": 1,
  "markScale": 1.55,
  "markBoxes": { "42": 56 },
  "compactBelow": 48,
  "palette": { "ink": "#000", "lime": "#00c060", "plum": "#8e4585" },
  "inkColors": ["ink"],
  "gradients": { "steel": ["#f1f4f7", "#aeb8c3", "#66717e"] },
  "aliases": { "green": "lime" },
  "hues": { "ink": "neutral", "steel": "neutral" },
  "tint": {
    "light": { "lime": { "bubble": "#0d9655", "ink": "#ffffff", "fill": "#10ab61", "hover": "#0d9655", "fillInk": "#ffffff" } },
    "dark": { "lime": { "bubble": "#0e9f5a", "ink": "#f5f5f5", "fill": "#0e9f5a", "hover": "#13bb6b", "fillInk": "#f5f5f5" } }
  },
  "shapes": { "round": "shapes/round.json", "drop": "shapes/drop.json" },
  "fallback": { "shapes": ["round", "drop"], "colors": ["lime", "plum"] },
  "bots": { "Example Bot": { "shape": "drop", "color": "steel" } }
}
```

- **Looks.** A bot named in `bots` (any case, surrounding spaces ignored) takes that shape and
  colour. Otherwise its server colour is used when the palette has it (directly or through
  `aliases`), a server colour sent as `#rrggbb` takes the nearest `fallback` colour, and
  anything left is picked from `fallback` by the bot's id, so it never changes.
  A renamed bot can retain its original motion by setting `engineName` to its name in the
  local engine's roster. For example, `"Scout": { "engineName": "First Mate", "primaryTile": true }`
  displays Scout on the primary card and uses First Mate's motion seed.
- **Colours.** `palette` colours draw as they are, `inkColors` in the skin's text colour (or in
  `ink.light` / `ink.dark` when the pack sets `"ink": { "light": "#000", "dark": "#fff" }`),
  `gradients` top to bottom.
- **Primary card.** Set `"primaryTile": true` in a named bot's entry to put it in the full-width card at the top of the sidebar on devices with the pack, even when the bot is unpinned. The card shows the bot's name and latest line. Without a pack match, the first pinned bot gets the card. Other pinned bots appear as tiles. Search lists matching bots as rows.
- **Size.** The mark is drawn in a square `markScale` times the avatar slot (or the size
  `markBoxes` pins for that slot), centred on it, so it may reach past the slot. Squares
  smaller than `compactBelow` use the compact working frames.
- **Chats.** With `tint`, a conversation with one bot shows the person's own bubbles and the
  Send and Stop button in that bot's `hues` entry (or its colour's name); groups keep the
  app's colours.

## Local avatar engine

A desktop built with the `local-engine` feature can also run a local avatar engine the person
installs beside the pack, in `avatars/engine/`. Superbot then draws every mark live from that
engine instead of the pack's frames, and keeps using the pack's palette, tints and bot choices.
Without the folder, or when the engine fails to start or throws, marks fall back to the pack's
frames, and without a pack to the built-in face. Like packs, engines are personal files: never
bundled, downloaded or uploaded.

`engine.json` names the entry module: `{ "version": 1, "module": "bridge.js" }`. Modules are
ES modules loaded only from files directly inside `engine/`, into one embedded V8 runtime on
its own thread, shared by every mark. The module exports:

| Function                            | Does                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `look(bot, chosen)`                 | `{ seed, shape, color }` for `{ id, name, color }`; `chosen` holds a shape or colour from the person's pick or `pack.json` |
| `mount(key, mark, now)`             | Starts a mark: `{ seed, shape, box, working, reduced }`                   |
| `update(key, working, now)`         | The mark starts or stops working                                         |
| `pointer(key, rect, point, now)`    | The pointer is over the mark's region; `rect` is the mark's square        |
| `release(key, now)`                 | The pointer left or pressed the region                                   |
| `unmount(key, now)`                 | The mark is gone                                                         |
| `tick(now)`                         | Runs what is due at `now` and returns `{ frames: [[key, svg]], busy }`  |

`now` is milliseconds on the engine's own clock. Each frame is a whole SVG with a 192 viewBox,
drawn in `#010203`, which Superbot repaints in the bot's colour. While `busy`, or while pointer
input waits, one shared pulse runs on the display's own frames: up to 60 times a second, on every
display frame or every second, third, ... on faster displays, so motion stays even. While the
pointer moves over, leaves or presses a mark, and for a second after while it turns back, the pulse
runs up to 120 times a second (every frame of a 144 Hz display); never with reduced motion on. Each pulse
gives the engine only the latest pointer sample per mark, calls `tick` with that frame's time and
shows what the engine drew for the previous pulse. When nothing moves, nothing runs. Starting a
mark or a change of work draws at once.

`SUPERBOT_AVATAR_TRACE`, set to a file path, records the pipeline for profiling: `request`
(a pulse asked for a frame), `tick` (start, duration, whether marks changed), `show` (a mark
showed a new frame, and when it was drawn) and `pointer`, in milliseconds.

## Frames files

One JSON file per shape. Each frame is a whole single-colour SVG; the app paints it in the
bot's colour, so holes (the eyes) show the surface behind.

| Field                       | What it holds                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `version`, `fps`            | 2, and the frame rate the loops and bridges were taken at                            |
| `rest`                      | The still pose                                                                       |
| `gazeRate`                  | How fast a turn closes its gap, per second: `e^(−gazeRate·t)` of it is left          |
| `gazeX`, `gazeY`, `holds`   | The pointer grid (−1 to 1, y up) and the hold levels, rising to 1                    |
| `gaze[]`                    | Per grid point, rows of `gazeY` then `gazeX`: `frames[]`, one per hold               |
| `working`, `workingCompact` | Seamless loops for a bot at work, normal and compact                                 |
| `start`, `startJoin`        | The bridge from rest into work, and the `working` frame it hands over to             |
| `stop[]`                    | Bridges to rest: `at`, the `working` frame each starts from, and its `frames[]`       |

The pointer is measured from the mark's centre in half-squares, as `(pointer − centre) /
(square / 2)`, clamped. A mark has a gaze point and a hold, from 0 at rest to 1 fully turned.
While the pointer is over its region the point chases the pointer and the hold rises to 1;
when it leaves or presses, the hold falls to 0. Both close their gap at `gazeRate`, and from
rest the point starts at the pointer. Each moment shows the grid pose nearest the point at
the nearest hold, so a turn follows a moving pointer and a brief hover turns only part way.

A bot that starts work while its mark is shown plays `start`, then the loop from `startJoin`;
one shown already at work starts the shared loop at its own place, so bots at work move out of
step. When work ends, the loop runs on to the next `stop` bridge and plays it to rest; work
that ends during `start` plays `start` back to rest. A mark still under the pointer then turns
again from rest.

Frames files in format 1 still load. Their `gazeX`, `gazeY`, `easeMs` and `gaze[]` hold
`approach[]`, `settled` and `leave[]` per grid point; a frame taken `t` into a turn counts
as the hold the turn had reached, `1 − e^(−rate·t)` toward the pointer and `e^(−rate·t)` back,
at the rate those files were all taken at (9.05 per second). They have no bridges, so their
marks cut between rest and work.

## Measured limits

- One loop per shape: two bots of the same shape at work move the same way, offset in time.
- The gaze grid is 9 × 5 points; between points the pose steps to the nearest one.
- Compact marks (smaller than `compactBelow`) have no bridges: they cut between rest and work.
- A stop waits for the next captured bridge, up to the pack's spacing between them.
- Only the sidebar's rows and tiles and the chat header pill turn toward the pointer. Group
  avatars, mention lists, the plugin page and the workspace panel keep the still pose (the
  panel's activity rows move while a run is in progress).
- With GPUI's reduce-motion setting on, marks are drawn where a turn or bridge ends and loops
  hold still (not checked in the app, nor whether the setting follows the system).
- Gradient colours are rasterised by the app for each frame shown and kept, up to 1,500
  images, then drawn again as needed.
