/**
 * The "Build an app" prompt: one self-contained text a person pastes into a coding agent so it can
 * build a Superbot app with this SDK. The website serves it verbatim, so it imports nothing and
 * holds no runtime values; it points at the public repository's docs for the details.
 */
export const BUILD_APP_PROMPT = `You are going to build an app for Superbot, an open-source AI assistant (https://github.com/z4mbo/superbot). Superbot apps are small tools a person uses through buttons and forms and a bot uses through tools, both running the same declared actions. Build it with the Superbot Apps SDK, exactly as described here, and check it before you finish.

## What to read first

Clone https://github.com/z4mbo/superbot and read:
- docs/plugin-sdk.md: the whole SDK (manifest, actions, hosted data, server functions, network, cards, limits).
- examples/food-diary/: a complete app with hosted records, server functions and a card. Copy its patterns.
- docs/pages.md: the page kit the app's view is written with.

## The app folder

An app is a folder with:
- app.json: the manifest.
- app.jsx: the view, one JSX file with one default export, written like a Superbot page.
- server.js: optional, the server functions, one JavaScript module with no imports.
- icon.png: optional, square.

Start from the starter instead of a blank folder:
- With the superbot-plugin command (apps/plugin-kit in the repository; build it with \`pnpm install\` and \`pnpm --filter superbot-plugin-kit build\`): \`superbot-plugin app-init my-app --name "My app"\`.
- Or copy examples/food-diary and change its id, name and version.

## app.json

Required: id (lowercase words joined by hyphens, stable across versions), name, version (semantic, like 1.0.0), description, entry ("app.jsx").
Optional: server ("server.js"), permissions, initialState, actions, data, network, cards, icon.

Permissions (ask only for what the app uses):
- state: the app keeps one JSON state object; needed for actions with "effects".
- data: the app keeps records in the collections "data" declares; needs "server".
- network: server functions may call the HTTPS hosts "network.hosts" lists; needs "server".
- agent:read: bots read the app and run its read-only actions.
- agent:actions: bots run its other actions.
- reply, links, clipboard: the view may suggest a chat reply, open a link the person confirms, or copy text on a click.

Actions: each has a name, a short description (bots read it to decide when to use it), an input of typed fields, and either "effects" (data steps on the state, for simple apps) or "run" (the name of a server function). Add "readOnly": true to a "run" action that only reads. Input fields are { "type": "string" | "number" | "boolean" } with "required", "description", and "maxLength"/"enum" for strings or "min"/"max"/"integer" for numbers. A field's description is also its label in forms, so keep it short ("Grams").

Hosted data:
"data": { "collections": { "entries": { "fields": { "date": { "type": "string", "required": true, "maxLength": 10 } }, "index": ["date"] } } }
Up to 8 collections, 32 fields each; index up to 3 fields per collection (only indexed fields can be filtered or sorted). Records get id, createdAt and updatedAt from the platform; never declare those names. Each record is at most 16 KB; an install keeps at most 10,000 records and 10 MB.

Cards: named views a bot can show in the chat.
"cards": [{ "name": "day", "title": "Day summary", "description": "When to show it.", "input": { "date": { "type": "string", "maxLength": 10 } } }]

## server.js

Export one async function per "run" action. Each is called with (ctx, input), where input is already checked against the action's declared input, and returns JSON.
- ctx.db.collection(name): insert(fields), get(id), list({ where, order, limit, cursor }) returning { items, nextCursor }, update(id, changes), remove(id). "where" filters indexed fields by a value or a range ({ gte, gt, lte, lt }); "order" is an indexed field, "createdAt" or "updatedAt", or { by, direction }; limit is at most 200.
- ctx.fetch(url, { method, headers, body }): HTTPS only, only to listed hosts; answers { status, ok, headers, text(), json() }. No redirects are followed.
- ctx.now (ISO time), ctx.today (YYYY-MM-DD in the person's time zone), ctx.timeZone.
- Throw an Error with a clear message to refuse bad input; the person or the bot sees it.

Rules: no imports, no require, no timers, no globals beyond plain JavaScript. A run has 1 second of CPU, 10 seconds in all and 32 MB of memory. A read-only action cannot write records and can only send GET or HEAD. Every other action's writes land together or not at all. Validate anything the declared input cannot express (a date format, for example) in the function.

## app.jsx

Written like a Superbot page: React and the page kit components are in scope without imports (Page, Section, Metrics, Rows, Table, Text, Callout, Status, Button, and the rest in docs/pages.md). Use only kit components and plain HTML elements, no network, no colours of your own. The app also gets:
- useAppState(): the state, read-only (with "state").
- useAction("name"): a function to call from a click; it resolves { ok, result } or { ok: false, error }.
- useQuery("name", input): { data, error, loading, refetch } for a read-only action; it updates by itself when the app's records change.
- useCard(): { name, input }, the card the bot opened, or name null for the whole app.
- <ActionButton action="name" input={{ ... }} label="..." /> and <ActionForm action="name" label="..." fixed={{ ... }} />.
Run actions only from a click or key, never from an effect. Read data with fallbacks (data?.items ?? []). Draw each card when useCard().name matches it, and the whole app otherwise.

## Check it

Run the same check the server runs, and fix every problem it reports:
- superbot-plugin app-check my-app
- or, inside a clone of the repository: pnpm app:check path/to/my-app

## Install it

1. Sign in once: superbot login (the server's address with --server, or SUPERBOT_SERVER).
2. Submit the version: superbot-plugin app-publish my-app
3. A deployment admin approves it. On your own server you are the admin: approve it in the review queue.
4. Open the Store, go to Apps, add the app and allow what it asks for. A bot finds it with find_apps, runs its actions with run_app_action, and shows it or one of its cards with open_app.
5. To change it later, raise "version" and publish again.

When you finish, report the folder, what each action and card does, and the output of the check.
`;
