# Build an app

An app is a [page](./pages.md) with its own stored state and a list of actions. You use it through
its buttons and forms; a bot uses the same app through two tools. Both run the same declared
actions on the same state, so a dashboard a bot keeps up to date is also one you can edit by hand.

Apps are built with the plugin SDK (`packages/plugin-sdk`), which sits on top of the page kit. They
run in the same sandboxed viewer as pages: an app's page loads nothing from the network, and it can
reach outside itself only through the permissions it declares.

An app you publish and install from the Store's Apps section can do more: keep **records** on the
server (hosted data), run **server functions** in a sandbox there, call the **HTTPS hosts** it
names, and offer **cards** a bot shows in the chat. [Food Diary](../examples/food-diary) is a
complete example of all four.

> "Plugin" elsewhere in Superbot means MCP servers and skills imported from GitHub
> ([Build a plugin](./build-a-plugin.md)). Apps are different: they are pages with state.

If you build with a coding agent, paste it the [Build an app prompt](#build-with-a-coding-agent).

## Ask a bot for one

- "Make me an app that tracks our team's open tasks, where you and I can both add and close them."
- "Turn the launch page into an app with a status I can change."

The bot saves the app with `save_page`, passing the manifest described below, and it opens as a
card in the chat like any page.

## An app folder

```text
team-dashboard/
  app.json        the manifest
  src/app.jsx     the entry: one JSX file, written like a page
  server.js       optional: server functions, for an installed app
  icon.png        optional
```

The example in [`examples/team-dashboard`](../examples/team-dashboard) is a complete app. Check a
folder before you share it:

```sh
pnpm app:check examples/team-dashboard
```

The check reads `app.json`, then checks the entry with the page kit's rules plus the app names below,
that the two agree (every action and card the code names is declared), and that the server file is
one module with no imports that exports every function an action runs. `superbot-plugin app-check`
runs the same check (see [Create, check and install an app](#create-check-and-install-an-app)). It reports problems with line
numbers. Files may use CRLF or LF line ends and a byte-order mark; names must match the manifest
exactly, including case, so a folder that works on Windows or macOS works on Linux too.

## app.json

```json
{
  "id": "team-dashboard",
  "name": "Team dashboard",
  "version": "1.0.0",
  "description": "Open tasks and the team's status.",
  "entry": "src/app.jsx",
  "permissions": ["state", "agent:read", "agent:actions"],
  "initialState": { "status": "On track", "tasks": [] },
  "actions": [
    {
      "name": "addTask",
      "description": "Add an open task.",
      "input": { "title": { "type": "string", "required": true, "maxLength": 120 } },
      "effects": [{ "op": "append", "path": "tasks", "assignId": true }]
    }
  ]
}
```

| Field          | Required | What it is                                                                                                  |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | Lowercase words joined by hyphens, at most 64 characters. Stays the same across versions.                   |
| `name`         | yes      | What people see, at most 80 characters.                                                                     |
| `version`      | yes      | A semantic version such as `1.0.0`.                                                                         |
| `description`  | yes      | One or two sentences, at most 500 characters.                                                               |
| `entry`        | yes      | The JSX file inside the folder, with forward slashes (`src/app.jsx`). A bot saving inline can leave it out. |
| `permissions`  | no       | What the app may do; see below. Defaults to none.                                                           |
| `icon`         | no       | A `.png`, `.jpg` or `.webp` inside the folder.                                                              |
| `initialState` | no       | The JSON object a new copy starts with. At most 64 KB.                                                      |
| `actions`      | no       | Up to 32 declared actions.                                                                                  |
| `server`       | no       | The server file (`.js` or `.mjs`) whose functions actions `run`. Installed apps only.                       |
| `data`         | no       | The collections of records the app keeps; needs the `data` permission and `server`.                        |
| `network`      | no       | `{ "hosts": [...] }`: the HTTPS hosts server functions may call; needs `network` and `server`.            |
| `cards`        | no       | Up to 8 named views a bot can show in the chat.                                                             |

Paths never start with `/`, never contain `..`, `\` or a drive letter, and avoid names Windows
reserves (`con`, `aux`, `nul`, `com1`...).

## Permissions

Declare only what the app needs. Each one is enforced by the host, not by the app's code.

| Permission      | Lets                                                       |
| --------------- | ---------------------------------------------------------- |
| `state`         | The app keep state between visits. Needed for any `effects` action.                        |
| `agent:read`    | Bots in the chat read the app's state and run its read-only actions.                       |
| `agent:actions` | Bots in the chat run the app's other actions.                                              |
| `reply`         | The app's `ReplyButton` put text in the chat's composer.                                   |
| `links`         | The app ask to open a web or mail link, which you confirm.                                 |
| `clipboard`     | The app's `CopyButton` copy text.                                                          |
| `data`          | The app keep records in the collections `data` declares. Installed apps only.              |
| `network`       | The app's server functions call the hosts `network` lists, over HTTPS. Installed apps only. |

The `agent:*` permissions need `state` or an action that runs a server function. The page itself
never reaches the network: the viewer blocks every request, and only server functions call out.

## Actions

An action has a `name`, a `description` (bots read it to decide when to run it), `input` fields and
either `effects` that run in order on a copy of the state, or `run`, the name of a server function
(see [Server functions](#server-functions)). If any step fails, nothing changes.

Inputs are plain values: `string` (with `maxLength`, `enum`), `number` (with `min`, `max`,
`integer`) and `boolean`. Each is optional unless `required`. Anything not declared is refused,
whether a person, a bot or the app's own code sent it. An input's `description` is what
`ActionForm` labels its field with, and what a bot reads, so keep it short ("Grams").

| Effect                                  | Does                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `set {path, from? \| value?}`           | Replaces the value at `path` with one input, a fixed value, or the whole input.                                          |
| `append {path, from?, assignId?, max?}` | Adds the input (or one field) to the list at `path`. `assignId` gives a new object an `id`; `max` keeps only the newest. |
| `update {path, key?, match?}`           | Changes the list item whose `key` (default `id`) equals input `match` (default `id`) with the other inputs.              |
| `remove {path, key?, match?}`           | Removes matching items. Removing what is already gone changes nothing.                                                   |
| `increment {path, from? \| by?}`        | Adds a number input, or `by`, or 1.                                                                                      |
| `toggle {path, field?, key?, match?}`   | Flips a boolean, or one `field` of the matching list item.                                                               |

A path is dot-separated keys (`stats.done`) of letters, digits and underscores. Effects are data,
not code: the server runs them, so an app's code never runs outside the viewer.

## In the code

An app's entry is written exactly like a page (see the page kit guide a bot gets from
`save_page {"help": true}`), with six more names in scope:

- `useAppState()`: the current state, read-only. It updates when anyone runs an action.
- `useAction("addTask")`: a function to call from a click or key. It resolves `{ ok: true }` or
  `{ ok: false, error }`.
- `<ActionButton action="toggleTask" input={{ id: task.id }} label="Done" />`: runs one action with
  a fixed input.
- `<ActionForm action="addTask" label="Add task" />`: fields for the action's inputs and a button;
  `fixed={{ ... }}` sets inputs the form does not show. It clears after a run.
- `useQuery("day", { date })`: the answer of a read-only action, as `{ data, error, loading,
  refetch }`. It loads when the view opens, and is read again after any action the view runs and
  whenever the app's records change elsewhere (a bot logged something, another tab added a row).
  Nothing polls: the server signals the change.
- `useCard()`: `{ name, input }`, the card a bot opened the app on, or `name: null` for the whole
  app. Draw the card's view when `name` matches.

An action that runs a function resolves `{ ok: true, result }` with what the function returned.

Actions run only from a person's click or key, one per click: an action an app starts on its own
(from an effect or a timer) is refused. Read state with fallbacks (`state.tasks ?? []`), since a
copy saved before you added a key will not have it.

## Hosted data

An installed app with the `data` permission keeps records in the collections `data` declares. Each
install has its own records, in each Space it is used in: nothing else reads them (the database's
row security holds this, not only the app's code), and they are deleted when the app is removed.

```json
"data": {
  "collections": {
    "entries": {
      "fields": {
        "date": { "type": "string", "required": true, "maxLength": 10 },
        "food": { "type": "string", "required": true, "maxLength": 120 },
        "grams": { "type": "number", "required": true, "min": 0 }
      },
      "index": ["date"]
    }
  }
}
```

Fields use the same types as action inputs, and every write is checked against them. Up to three
fields per collection can be `index`ed: those are the ones `list` filters and sorts on. Every
record also has `id`, `createdAt` and `updatedAt`, which the platform sets.

## Server functions

`server.js` is one JavaScript module with no imports. Each function an action `run`s is exported
and called with `(ctx, input)`, where `input` is the checked input, and returns JSON:

```js
export async function addEntry(ctx, input) {
  const entry = await ctx.db.collection("entries").insert({ date: ctx.today, ...input });
  return { entry };
}

export async function day(ctx, input) {
  const { items } = await ctx.db
    .collection("entries")
    .list({ where: { date: input.date ?? ctx.today }, order: "createdAt", limit: 200 });
  return { items, grams: items.reduce((sum, item) => sum + item.grams, 0) };
}
```

| `ctx`                          | What it is                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `ctx.input`                    | The checked input, also the second argument.                                                  |
| `ctx.now`, `ctx.today`         | The run's start as an ISO time, and today as `YYYY-MM-DD` in the person's time zone.          |
| `ctx.timeZone`                 | The person's time zone.                                                                       |
| `ctx.db.collection(name)`      | `insert(fields)`, `get(id)`, `list({ where, order, limit, cursor })`, `update(id, changes)`, `remove(id)`. With `data`. |
| `ctx.fetch(url, init)`         | An HTTPS call to a listed host, answering `{ status, ok, headers, text(), json() }`. With `network`. |

`list` filters an indexed field by a value or a range (`{ gte: 10 }`, `gt`, `lt`, `lte`), sorts by
an indexed field, `createdAt` or `updatedAt` (`{ by, direction }`), and pages with `nextCursor`.
A refused call (an unknown collection, a field the collection does not declare, a full quota)
throws an `Error` the function can catch.

Mark an action `"readOnly": true` when its function only reads. A read-only action runs without a
click (that is what `useQuery` asks for), a bot may run it with `agent:read`, and it cannot write
records or send anything but `GET` and `HEAD`. Every other action runs in one transaction: its
writes land together or, when it throws, not at all.

Functions run in a WebAssembly sandbox on the server with no file system, environment, timers,
modules or network of their own. Each run has 1 second of CPU, 10 seconds in all, 32 MB of memory
and 200 platform calls; its input may be 16 KB and its answer 64 KB of JSON.

## Network

```json
"permissions": ["data", "network"],
"network": { "hosts": ["api.example.com"] }
```

Server functions may call only the exact hosts listed, over HTTPS on the standard port. A host
that resolves to a private, loopback or link-local address is refused, and so is every redirect.
The platform adds nothing to a request (no cookies, no credentials of its own), and an app cannot
set `Cookie`, `Host` or forwarding headers. A run makes at most 10 calls of 8 seconds each, with
64 KB sent and 1 MB read per call. The person sees the hosts before installing the app.

## Cards

A card is a named view of the app that a bot shows in the chat with `open_app {app_id, card,
input}`. Declare it with a `description` the bot reads to decide when to show it, and an `input`
if it takes one:

```json
"cards": [
  {
    "name": "day",
    "title": "Day summary",
    "description": "One day's totals. Show it after logging food.",
    "input": { "date": { "type": "string", "maxLength": 10 } }
  }
]
```

In the code, `useCard()` says which card the view was opened on. The card's input reaches the app
as data, never as markup, and the card reads the app's records live through `useQuery`, so it stays
current when they change. Its footer opens the whole app.

## Create, check and install an app

The `superbot-plugin` command ([apps/plugin-kit](../apps/plugin-kit/README.md)) creates, checks and
submits app folders:

```sh
superbot-plugin app-init meal-log --name "Meal log"   # a starter with records, functions and a card
superbot-plugin app-check meal-log                    # the server's own check, offline
superbot-plugin app-publish meal-log                  # submit the version for review
```

`app-init` copies Food Diary under your folder's name, so every part of the SDK is there to change
or delete. `app-publish` uses the session `superbot login` saved. A deployment admin approves the
version (on your own server, that is you); it is then listed in the Store's Apps section, where you
install it and allow what it asks for. A new version needs a higher `version`; installs keep the
version they installed.

## How bots use an app

A bot reaches the apps it can reach as pages (its own, and its group's in a group chat) and the
apps its person installed in the Space.

- `find_apps {query}` lists the installed apps, each with its `app_id`.
- `read_app_state {pageId}` or `{app_id}` returns the app's name, version, state and revision, the
  actions the bot may run with their inputs (read-only ones marked), and its cards.
- `run_app_action {pageId or app_id, action, input}` runs one declared action and returns the new
  state, or what its server function returned.
- `open_app {app_id, card?, input?}` shows an installed app in the chat, or one of its cards.

Reading and acting are refused unless the app declares the matching `agent:*` permission and, for
an installed app, its install granted it too. An installed app keeps its state on a page of its
own, made the first time it is opened or acted on; removing the app removes that page. What a bot
reads from an app counts as outside content, like anything else people wrote.

## Where apps run

| Surface                                              | What works                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Web, and the desktop app on Windows, macOS and Linux | Everything: the app opens where pages open, its actions run, and cards draw live in the chat. |
| Mobile                                               | The app shows its stored state; its buttons and forms are off, and views that read hosted data say to open the app on the web or desktop. A card shows as the app's page card. |
| Shared links                                         | The app shows its starting state from `initialState`, and runs no actions. |

## Limits

- State: 64 KB of JSON. An action that would grow it past that is refused.
- Source: the page limit of 256 KB.
- 32 actions, 16 inputs and 8 effects per action.
- Two actions landing at the same moment both apply, one after the other; past three collisions
  the action is refused with "try again".
- Hosted data: 8 collections of up to 32 fields; 16 KB per record; 10,000 records and 10 MB per
  install in a Space. `list` returns up to 200 records a page.
- Server file: 128 KB. Server functions: the run limits under [Server functions](#server-functions).

## Build with a coding agent

[`packages/plugin-sdk/src/guide/build-app.prompt.ts`](../packages/plugin-sdk/src/guide/build-app.prompt.ts)
holds a prompt to paste into a coding agent so it builds a Superbot app with this SDK: the manifest,
hosted data, server functions, cards, the check, and how to install it.
