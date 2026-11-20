# Hosted and local runs in the desktop chat

The desktop chat sends a turn one of two ways. The model chosen for the bot decides which.
The header shows the model's name after its maker's mark. The model picker opens from the
header or from **Details → Model**.

| | Hosted model | Model CLI on this computer |
| --- | --- | --- |
| Where it runs | The server's run worker, through the Space's model connection | The desktop starts the CLI on this device (`superbot_features::local_cli`, or an ACP engine through `local_acp`) |
| Who can choose it | Any member who can change the bot | The member on this device. The choice is stored per device, server, account and Space |
| Sending | `threads/send`. The composer keeps the text until the server confirms it | The message appears at once, faded, and the composer clears. A failed or stopped run puts it back in the composer |
| Reply | Streams into a draft bubble over `threads/subscribe` | Arrives whole. It shows faded until `append_local_turn` saves it to the shared thread, and stays visible with **Retry saving** if the save fails |
| Working row | From the run's events, with its activity text | "Working…" while the CLI runs |
| Stop | `threads/stop` ends the server run | Cancels the CLI task. Nothing is saved |
| Tools and approvals | Server tools, the agent's computer and granted plugins. Question and approval cards are answered with `threads/answer` | None. Claude Code runs with `--tools ""` and an empty MCP config, Codex with a read-only sandbox and its shell, browser and computer tools off, and ACP engines get no file system, terminal or MCP, with every permission request refused |
| Context | The server thread with memory, skills and granted plugins | The conversation's last 40 text messages, without files. Attachments must be removed before sending |
| App records | Through granted plugins, approved per call | **Apps** in the composer or `/apps` sends one app's recent records to the model. A suggested record is added only after **Add** |

## The agent's computer

Only hosted runs use the agent's computer. The run worker gives the model its computer
tools (screen, input, shell, files, apps and a browser) and runs each call on the computer
provisioned for that bot, through the computer provider the Space chose. Space approval
rules can refuse these calls, and payments or saved logins always ask. The provider decides
where the computer lives. Every provider a production server uses is isolated from the
server. The one kind that runs on the host machine itself is refused unless the server
runs inside the desktop app or in development.

A turn from a model CLI on this computer gets none of these tools. It runs as a single
prompt and its reply is saved to the thread. No server run starts, so it never reaches the
computer. There is no path that lets a local CLI drive the agent's computer, and the
desktop does not offer one. For work that needs the computer, choose a hosted model for
the bot.

The person can use the computer from the **Computer** tab of the bot's side panel, whichever
model the bot uses. They can start and stop it, watch its screen, take and hand back
control, and browse and download its files. Typing on the screen, opening its terminal and
uploading files require holding control.

## Model picker

The picker matches the Simple menu of the reference app. The current model sits at the top
with a check. **Use the main model** follows the Space's choice. Each connection and each
CLI on this computer gets its own group, headed by its maker's mark, with three suggestions
and **Show all**. Starred models move up the next time the menu opens. Thinking and
**Manage models** stay at the bottom.

Marks come from the shared table in `packages/core/src/models/model-marks.ts`, which the
web and mobile pickers use. The desktop embeds that file at build time and reads it when it
first draws a mark, so all three clients show the same marks and colours. A group gets a
mark only when every model in it has the same maker. Without one it falls back to the
generic hosted or local glyph. Brand marks rest at 60% and lift to full colour under the
pointer. Black marks rest in the tertiary ink.

## Verified

On Windows, against the disposable fixture from [chat verification](chat-verification.md)
with its synthetic local CLI and offline model emulator:

- The picker showed the current local model and a Claude Code group headed by its maker's
  mark. The hosted fixture connection, whose model has no known maker, kept the generic
  glyph. The header showed the same mark before the model name. Both were captured at rest
  and under the pointer, in Midnight and Daylight.
- A local turn showed the message at once, faded, above the working row. The composer
  cleared and its button became Stop. The saved exchange replaced the faded bubble without
  a duplicate. Stopping a second turn put its text back in the composer, and nothing was
  saved after the CLI would have answered.
- Unit tests cover reading the shared table and naming makers as the web picker does.

The hosted rows of the table come from the source, not from a run. No hosted provider was
called, and no real account or conversation was opened.

## Known gaps

- Replies from local CLIs arrive whole. ACP engines can report text as it arrives, but the
  desktop does not show it, which matches the reference's whole replies.
- Local turns have no tools or approvals by design. Use a hosted model for work that needs
  them.
- A bot message's **Retry** action is not built yet for either kind of run.
- **Details → Model** in the side panel shows no mark yet.
