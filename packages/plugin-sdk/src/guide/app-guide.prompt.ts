/** Returned by save_page {"help": "app"}, so ordinary turns do not pay for it. */
export const APP_GUIDE = `# Apps

An app is a page with stored state and declared actions. The person uses it through its controls; you read its state with read_app_state and run its actions with run_app_action. Both run the same declared actions on the same state. Everything in the page kit guide (save_page {"help": true}) applies; this adds the app parts.

## Save an app
save_page {title, source, app}, where app is the manifest:
{"id": "team-tasks", "name": "Team tasks", "version": "1.0.0", "description": "Open tasks.",
 "permissions": ["state", "agent:read", "agent:actions"],
 "initialState": {"tasks": []},
 "actions": [{"name": "addTask", "description": "Add a task.",
   "input": {"title": {"type": "string", "required": true, "maxLength": 120}},
   "effects": [{"op": "append", "path": "tasks", "assignId": true}]}]}
To change an app later, pass its pageId with edits or source, and app again when the manifest changes. Its state stays.

## Permissions (list only what the app needs)
- state: the app keeps state, and its actions change it. Needed for any action.
- agent:read: you can read its state. agent:actions: you can run its actions.
- reply, links, clipboard: its ReplyButton, links and CopyButton work.

## Actions
An action has a name, a description you will read later, inputs (string with maxLength/enum, number with min/max/integer, boolean; each optional unless required) and effects run in order:
- set {path, from? | value?}: replace the value at path with one input, a fixed value, or the whole input.
- append {path, from?, assignId?, max?}: add the input (or one field) to the list at path; assignId gives an object an id; max keeps the newest.
- update {path, key="id", match="id"}: change the list item whose key equals input match with the other inputs.
- remove {path, key="id", match="id"}: remove matching items.
- increment {path, from? | by?}: add a number. toggle {path, field?, match?}: flip a boolean, or one field of a matching item.
A path is dot-separated keys ("stats.done"). The state is JSON, at most 64 KB.

## In the code
- useAppState(): the current state, read-only; it updates when anyone runs an action.
- useAction("addTask"): a function to call from a click, resolving {ok} or {ok: false, error}.
- <ActionButton action="toggleTask" input={{id: task.id}} label="Done" />: runs an action with a fixed input.
- <ActionForm action="addTask" label="Add" />: fields for the action's inputs and a button; fixed={{...}} sets hidden inputs.
Actions run only from a person's click or key; never call one from an effect or a timer. Read the state with fallbacks (state.tasks ?? []) since an older copy may lack a key.`;
