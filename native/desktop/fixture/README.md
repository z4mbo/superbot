# Chat fixture

A disposable server for checking the desktop's chat against known data. It starts its own
PostgreSQL cluster, API and worker on free loopback ports, a deterministic model emulator,
and two synthetic accounts, and removes all of it when it stops. Nothing leaves the computer.

```powershell
pnpm db:generate
pnpm --filter @rakazo/api build
node --import tsx native/desktop/fixture/chat-parity.mjs "C:/path/to/postgresql/bin" "C:/path/to/output"
```

It prints `READY <origin>` and writes `fixture.json` (the origin and both accounts) into the
output folder once the data is in place, then serves until a file named `stop` appears there.
Run the desktop against it with `SUPERBOT_SERVER` set to that origin and sign in as the
owner. Stopping the fixture also removes the session the desktop saved for that origin.

| It makes                                                                             | For                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Fixture agent**, 112 exchanges plus two file messages (228 messages)               | Three pages of history at the server's 100 a page |
| Messages spread over three days, with a 39-minute quiet spell today                  | A stamp per day and one after a gap               |
| `launch-notes.txt` and `pixel.png` sent to the agent, one with words and one without | File cards, saving, attachment-only messages      |
| **Fixture discussion**, a group of Fixture agent and Support agent                   | Speaker names, mentions, who answers              |
| A second person (Observer) who writes in the group                                   | Another person's messages                         |

`CHAT_PARITY_EXCHANGES` shortens the agent's history for a quick start. The model answers
every message with a fixed line, so replies are the same on every run.

## What was checked against it

On Windows 11, 19 November 2026, with the app driven by posted window messages and captured
off-screen, so it never took the foreground. The captures are in
`%LOCALAPPDATA%\Superbot\screenshots\chat-parity`.

| Behaviour               | Result                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older history           | Scrolling up loaded all three pages. Across each page boundary the messages on screen moved by exactly the distance scrolled, and the conversation's first message ended at the top with its day stamped.                                         |
| Time stamps             | "Mon, Nov 16 9:33 PM", "Yesterday 9:33 PM" and "Today 9:26 PM" appeared at the first message, each new day and after the quiet spell, in both the agent conversation and the group.                                                               |
| Attaching               | The system chooser added a text file and a picture as chips. A program chosen with them was left out with "tool.exe is a kind of file that can't be attached."                                                                                    |
| Attachment-only message | Sent with no words; the server stored one message carrying both files and the agent replied.                                                                                                                                                      |
| Failed send             | With the fixture's API frozen, the send timed out after 30 seconds. The words and the file stayed in the composer under "Couldn't reach the server. Check that it is running and try again."                                                      |
| No duplicates           | After the API was resumed, sending the same words and file again stored exactly one message and one new file. Whether the frozen server later processed the first attempt's upload was not observed; the retry reuses the same nonces either way. |
| Live replies            | Messages and replies arrived as they were written and the view followed them.                                                                                                                                                                     |
| Group mentions          | `@` listed both bots; typing narrowed the list; Down moved through it; Escape closed it; Enter completed the name. The message went with the mention and only the named bot answered.                                                             |
| Saving a file           | Save fetched `agenda.md` through the group it was sent in and wrote a file identical to the one uploaded.                                                                                                                                         |
| Drafts                  | Words and a file left unsent in the group were still there after opening the agent and coming back; the agent's composer was empty meanwhile.                                                                                                     |
| Both skins              | Midnight and Daylight.                                                                                                                                                                                                                            |

Two faults the fixture found were fixed in the same change: the app stopped when the view
reached the top of the loaded history, and a live reply could be drawn after the message that
followed it.

## What was not checked

- **Open** on a file. It hands a copy to the system's viewer, which comes to the foreground,
  so it was left out of an unattended run. Which kinds may be opened, and the name and place
  of the copy, are covered by unit tests.
- The tooltip with a message's full date, which needs a resting pointer.
- The "Earlier messages" pill, which only shows while the loaded page does not fill the
  window, and the line shown when an older page cannot be read.
- The 3,000-message bound and its "Older messages are on the web." line.
- A file over the server's size limit, and a message with more files than it allows.
- A send that fails with an answer from the server, such as a refused file type, as opposed
  to no answer at all.
- A window at its minimum size, and long or right-to-left names.
