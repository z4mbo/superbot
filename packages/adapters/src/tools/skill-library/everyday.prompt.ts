import type { LibrarySkill } from "./library-skill.js";

/** Everyday work: time, email, meetings, news, research and writing. */
export const EVERYDAY_SKILLS: LibrarySkill[] = [
  {
    name: "Schedule a meeting",
    description:
      "Find a time that works and set up the meeting. Use when asked to schedule, reschedule or find a slot.",
    body: `1. Ask for what's missing: who should attend, how long, the date range, in person or online, and any time that must stay free.
2. Read the user's calendar if one is connected, and any attendee availability you can see. If no calendar is connected, ask the user for their free times and work from those.
3. Offer up to three slots that fit everyone you could check. Give each in the user's time zone, and in the attendees' zones when they differ. Name anyone whose availability you couldn't see.
4. When the user picks a slot, show the exact invitation: title, time, attendees, location or call link, and the note to attendees.
5. Confirm before sending. Create the event or send the invitation only after the user says yes to that exact invitation.
6. Hand back: the confirmed time and a link to the event, or the text of the invitation if you couldn't send it.`,
  },
  {
    name: "Weekly planning",
    description:
      "Plan the week ahead around priorities, deadlines and meetings. Use when asked to plan the week or decide what to focus on.",
    body: `1. Ask for this week's top priorities if you don't have them in memory, and any fixed deadlines.
2. Read this week's calendar and open tasks from the apps you can reach. Note overloaded days, overlaps and priorities with no time set aside.
3. Suggest a plan: the three outcomes for the week, when to work on each, and meetings that could be shortened, moved or declined.
4. Confirm before changing anything. Block time, move or decline meetings only for the changes the user approves.
5. Hand back: the week's plan in a few lines, and save the three outcomes to memory for later check-ins.`,
  },
  {
    name: "Clean up the inbox",
    description:
      "Cut inbox clutter: find bulk senders the user ignores and unsubscribe from the ones they pick. Use when asked to clean up email or stop newsletters.",
    body: `1. Ask how far back to look (default 60 days) and whether any senders must be kept.
2. With email connected, group newsletters, promotions and notifications by sender. Count messages per sender and how many the user opened, if the app shows it. Leave personal conversations out.
3. Show a numbered list of senders, least read first, at most fifteen.
4. Confirm before acting. Unsubscribe only from the senders the user picks, using the sender's own unsubscribe link or header. Never reply to senders, and skip any message that looks like phishing.
5. Never delete, archive or filter mail unless the user asks for that too.
6. Hand back: which unsubscribes worked, which need the user to finish on the sender's page, and the senders kept.`,
  },
  {
    name: "Draft an email",
    description:
      "Write an email or reply in the user's voice, ready to send. Use when asked to write, draft or answer an email.",
    body: `1. Ask for the recipient, the goal of the email and any facts it must include. For a reply, read the whole thread first.
2. Learn the user's tone from their sent mail when email is connected, or from what they tell you.
3. Write a short draft that answers every question in the thread or makes one clear ask. Put a bracketed placeholder for any date, price or commitment the user hasn't given you.
4. Show the draft. Save it as a draft in the user's email when you can.
5. Confirm before sending. Send only after the user approves this exact text and recipients.
6. Hand back: the final text and where it was saved or sent.`,
  },
  {
    name: "Meeting notes",
    description:
      "Prepare an agenda before a meeting or a recap after it. Use when asked for an agenda, meeting notes or a recap.",
    body: `1. Ask which meeting, and whether the user wants an agenda (before) or a recap (after).
2. For an agenda: collect open items from notes, the last recap and the invite. Order decisions first, then reviews, then updates. Give each item a time and an owner.
3. For a recap: work only from the notes, transcript or recording you were given. List decisions, action items with owner and date, and open questions. Never invent quotes, decisions or owners; mark anything unclear.
4. If you were given a recording but can't transcribe it, say so and ask for notes or a transcript.
5. Confirm before sharing. Post or send the agenda or recap only where and when the user says.
6. Hand back: the agenda or recap, kept short enough to read in a minute.`,
  },
  {
    name: "News briefing",
    description:
      "Brief the user on recent news about their topics, with sources. Use when asked what's new or for a news summary.",
    body: `1. Ask for topics, places and sources to prefer or avoid, unless they're in memory.
2. Search the live web. If you can't reach it, say so instead of giving old news.
3. Pick up to five items that matter most. Prefer original reporting and official sources, and check big claims with a second source.
4. Write one or two neutral lines per item with a link and how long ago it happened. Note where coverage disagrees.
5. Hand back: the briefing, and say which stories you left out because you couldn't confirm them.`,
  },
  {
    name: "Research a question",
    description:
      "Answer a research question with dated, linked sources. Use when asked to research, look into or fact-check something.",
    body: `1. Restate the question in one line. Ask one clarifying question if it's ambiguous.
2. Search from several angles on the live web if you have it. If you don't, say so at the top and answer only from what you know, noting its date limits.
3. Open the sources rather than relying on snippets. Prefer primary sources: official pages, filings, papers, the organization's own announcements.
4. Keep each claim with its source and date. Cross-check important numbers with a second source.
5. Hand back: a short answer, the evidence with numbered links and dates, what you could not verify, and the date you checked.`,
  },
  {
    name: "Write a document",
    description:
      "Draft a document such as a brief, plan, report or proposal from the user's notes. Use when asked to write or structure a document.",
    body: `1. Ask what the document is for, who will read it, how long it should be, and for any notes, data or past examples to work from.
2. Propose an outline first and agree on it with the user.
3. Write the draft from the material given. Never invent facts, numbers, quotes or names; mark anything that needs a source or a decision.
4. Keep paragraphs short and lead each section with its point.
5. Save the document where the user asks. Confirm before sharing it with anyone else.
6. Hand back: the draft or its link, and a short list of open questions.`,
  },
];
