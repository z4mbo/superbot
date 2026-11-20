# Bots that manage bots

A bot can create new bots or manage existing ones: create groups, organize the sidebar, rewrite
instructions, pick models and schedule routines. It can manage active bots in the current space,
whoever created them.

## Settings

Open a bot's settings and expand **Advanced** to change **Manage other bots**. The switch is on web,
the Electron desktop app (which hosts the web UI) and mobile bot settings.

- New bots start with it on, including bots created by another bot, duplicates and imported agents.
  Duplicates do not inherit this setting from the source bot. Existing bots keep their setting;
  [**Import data**](./account.md) restores the exported setting.
- The switch is checked on the bot that uses the tool. A bot with it off can still ask a bot with
  it on to create a bot.
- Turning it off also blocks creation that is waiting for approval.
- Subagents cannot create bots or use tools that manage existing bots, including `list_fleet`.

## Which runs can use the bot management tools

Runs you started can manage existing bots. This includes a message you sent in the app or from a
chat app you linked, a follow-up to your own message, the end of a call, or one of your routines.
Other runs can still use `update_bot` on the calling bot.

A bot can also create bots in runs started by another bot, a messaging channel or a webhook.
Creation follows the space's approval mode. In Ask and Auto, a messaging channel or webhook message
that starts or enters a run means **Always allow** cannot skip approval for bot creation. The same
rule applies to changes to existing bots once such a message enters a run you started. Never ask
allows these changes.

## Tools

- `spawn_bot`: creates a bot and can give it a first task.
- `list_fleet`: lists active bots, groups and sections, and marks the bots the caller created. With
  `bot_id`, it instead returns only that bot's full instructions and current version.
- `create_group`: creates a group from existing bots.
- `update_group`: renames a group or adds and removes members.
- `organize_bot`: sets a section (`section`), clears it (`clear_section: true`) or sets a pin on a bot
  or a group.
- `update_bot` with `bot_id`: edits another bot's name, description, color and
  notifications. It cannot change another bot's avatar image or instructions. Without `bot_id` it
  acts on the calling bot as before.
- `set_child_instructions`: replaces another bot's instructions. The bot passes the version it read
  with `list_fleet`.
- `set_child_bot_model`: sets or clears another bot's model and thinking level.
- `create_child_routine`: schedules a prompt for another bot, or starts it on a webhook, Git event, chat message or email.
- `archive_bot`: archives another bot after confirming its exact name. It cannot archive itself.

## Approval

In Ask and Auto, `set_child_instructions` and `set_child_bot_model` always show an approval card.
Auto-review and "Always allow" do not skip it, and the card offers allow or deny only.
`create_group`, `update_group`, `create_child_routine` and `archive_bot` follow the space's approval
mode like any other action. Never ask runs all of them. For group, instruction, model and routine
changes, the card lists what will actually run, resolved before the pause:

- Create group: the name and every member.
- Update group: the members added and removed, and the new name.
- Instructions: the whole new text, with the old and new lengths.
- Model change: the current and the new model (From and To), and a Thinking line when the thinking
  level is set or reset.
- Routine: the prompt, the resolved time and the events that start it.

If the request cannot be shown whole on the card, it is refused instead of cut off. If the bot's
instructions, model or thinking level change while the card waits, approving does not overwrite them;
the bot has to ask again.

By default, `list_fleet`, `organize_bot` and `update_bot` need no card. Space approval rules can
require one.

## What a bot cannot do

- Permanently delete a bot.
- Use bot management tools to read, request or change secrets. Instructions, profile fields and
  routine names and prompts containing credentials detected by the run's secret filter are refused.
- Change another bot's permissions, memory scope, computer, voice or app connections.
- Move a bot between spaces. Every tool works inside the space and account of the run.
- Remove itself from the group it is running in.

## Limits

- A group has 2 to 10 members.
- Instructions are at most 20,000 characters.
- `list_fleet` returns at most 200 bots and 100 groups, and says when the result is truncated.
- A bot writes at most one set of instructions per bot per run, and must pass the version it read.
  If that bot changed in the meantime, the edit is refused and the bot reads it again.

## History, events and routines

Instruction edits are saved as versions in the bot's instructions history, with the reason
"Updated by" and the name of the bot that made them.

Creating a group appends a `group.created` event to the calling bot's thread; changing a group
appends a `group.updated` event to the group's thread. Changes to a bot append `bot.updated` to that
bot's thread.

Routines a bot creates for another bot are managed by you in that bot's **Routines** screen.
The managing bot cannot list or cancel another bot's routines.
