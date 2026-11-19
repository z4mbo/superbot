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
- **Colours.** `palette` colours draw as they are, `inkColors` in the skin's text colour,
  `gradients` top to bottom.
- **Primary tile.** Set `"primaryTile": true` in a named bot's entry to reserve the first tile for it, 92px wide with a 16px crown badge. It appears on each device that has the pack as soon as the bot is in the Space. Other pinned bots follow it. Search lists matching bots as rows. The setting affects only the local sidebar.
- **Size.** The mark is drawn in a square `markScale` times the avatar slot (or the size
  `markBoxes` pins for that slot), centred on it, so it may reach past the slot. Squares
  smaller than `compactBelow` use the compact working frames.
- **Chats.** With `tint`, a conversation with one bot shows the person's own bubbles and the
  Send and Stop button in that bot's `hues` entry (or its colour's name); groups keep the
  app's colours.

## Frames files

One JSON file per shape. Each frame is a whole single-colour SVG; the app paints it in the
bot's colour, so holes (the eyes) show the surface behind.

| Field                        | What it holds                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `version`, `fps`             | 1, and the frame rate the loops were taken at                                 |
| `rest`                       | The still pose                                                                |
| `gazeX`, `gazeY`, `easeMs`   | The pointer grid (−1 to 1, y up) and the times of each turning frame          |
| `gaze[]`                     | Per grid point, rows of `gazeY` then `gazeX`: `approach[]`, `settled`, `leave[]` |
| `working`, `workingCompact`  | Seamless loops for a bot at work, normal and compact                          |

The pointer is measured from the mark's centre in half-squares, as `(pointer − centre) /
(square / 2)`, clamped. Turning toward a point plays `approach` at the `easeMs` times and
holds `settled`; leaving or pressing plays `leave` back to `rest`. Each bot starts the shared
working loop at its own place, so bots at work move out of step.

## Measured limits

- One loop per shape: two bots of the same shape at work move the same way, offset in time.
- The pointer snaps between grid points while it moves over a region; only the first turn and
  the return to rest are eased.
- Only the sidebar's rows and tiles and the chat header pill turn toward the pointer. Group
  avatars, mention lists, the plugin page and the workspace panel keep the still pose (the
  panel's activity rows move while a run is in progress).
- Loops and turns are GPUI animations, which hold still when GPUI's reduce-motion setting is
  on; whether that follows the system setting on each platform was not checked.
- In a debug build, three marks at work cost about a fifth of one core on Windows.
