# Build an app

An app is a [page](./pages.md) with its own stored state and a list of actions. You use it through
its buttons and forms; a bot uses the same app through two tools. Both run the same declared
actions on the same state, so a dashboard a bot keeps up to date is also one you can edit by hand.

Apps are built with the plugin SDK (`packages/plugin-sdk`), which sits on top of the page kit. They
run in the same sandboxed viewer as pages: an app loads nothing from the network, and it can reach
outside itself only through the permissions it declares.

> "Plugin" elsewhere in Rakazo means MCP servers and skills imported from GitHub
> ([Build a plugin](./build-a-plugin.md)). Apps are different: they are pages with state.

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
  icon.png        optional
```

The example in [`examples/team-dashboard`](../examples/team-dashboard) is a complete app. Check a
folder before you share it:

```sh
pnpm app:check examples/team-dashboard
```

The check reads `app.json`, then checks the entry with the page kit's rules plus the app names below,
and that the two agree (every action the code names is declared). It reports problems with line
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

Paths never start with `/`, never contain `..`, `\` or a drive letter, and avoid names Windows
reserves (`con`, `aux`, `nul`, `com1`...).

## Permissions

Declare only what the app needs. Each one is enforced by the host, not by the app's code.

| Permission      | Lets                                                       |
| --------------- | ---------------------------------------------------------- |
| `state`         | The app keep state between visits. Needed for any action.  |
| `agent:read`    | Bots in the chat read the app's state. Needs `state`.      |
| `agent:actions` | Bots in the chat run the app's actions. Needs `state`.     |
| `reply`         | The app's `ReplyButton` put text in the chat's composer.   |
| `links`         | The app ask to open a web or mail link, which you confirm. |
| `clipboard`     | The app's `CopyButton` copy text.                          |

There is no network permission: the viewer blocks every network request for pages and apps alike.

## Actions

An action has a `name`, a `description` (bots read it to decide when to run it), `input` fields and
`effects` that run in order on a copy of the state. If any step fails, nothing changes.

Inputs are plain values: `string` (with `maxLength`, `enum`), `number` (with `min`, `max`,
`integer`) and `boolean`. Each is optional unless `required`. Anything not declared is refused.

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
`save_page {"help": true}`), with four more names in scope:

- `useAppState()`: the current state, read-only. It updates when anyone runs an action.
- `useAction("addTask")`: a function to call from a click or key. It resolves `{ ok: true }` or
  `{ ok: false, error }`.
- `<ActionButton action="toggleTask" input={{ id: task.id }} label="Done" />`: runs one action with
  a fixed input.
- `<ActionForm action="addTask" label="Add task" />`: fields for the action's inputs and a button;
  `fixed={{ ... }}` sets inputs the form does not show. It clears after a run.

Actions run only from a person's click or key, one per click: an action an app starts on its own
(from an effect or a timer) is refused. Read state with fallbacks (`state.tasks ?? []`), since a
copy saved before you added a key will not have it.

## How bots use an app

A bot reaches the apps it can reach as pages (its own, and its group's in a group chat) and the
apps its person installed in the Space.

- `find_apps {query}` lists the installed apps, each with its `app_id`.
- `read_app_state {pageId}` or `{app_id}` returns the app's name, version, state and revision,
  and, when the app allows `agent:actions`, its actions with their inputs.
- `run_app_action {pageId or app_id, action, input}` runs one declared action and returns the new
  state.
- `open_app {app_id}` shows an installed app in the chat as a page card.

Reading and acting are refused unless the app declares the matching `agent:*` permission and, for
an installed app, its install granted it too. An installed app keeps its state on a page of its
own, made the first time it is opened or acted on; removing the app removes that page. What a bot
reads from an app counts as outside content, like anything else people wrote.

## Where apps run

| Surface                                              | What works                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Web, and the desktop app on Windows, macOS and Linux | Everything: the app opens where pages open, and its actions run.           |
| Mobile                                               | The app shows its stored state; its buttons and forms are off.             |
| Shared links                                         | The app shows its starting state from `initialState`, and runs no actions. |

## Limits

- State: 64 KB of JSON. An action that would grow it past that is refused.
- Source: the page limit of 256 KB.
- 32 actions, 16 inputs and 8 effects per action.
- Two actions landing at the same moment both apply, one after the other; past three collisions
  the action is refused with "try again".
