import { inCategory } from "./template-category.js";

/** Email: triage, replies, follow-ups and less noise. */
export const EMAIL_TEMPLATES = inCategory("email", [
  {
    id: "inbox-triage",
    version: 1,
    name: "Inbox triage",
    summary: "Sorts new email and drafts the replies",
    sample: [
      "**12 new since 8:00**",
      "",
      "**Reply needed**",
      '1. Priya wants to move Friday\'s review. Draft: "Friday works if we start at 2."',
      "2. Your card expires on the 30th. Draft ready.",
      "3. Sam asked about the API limits. Draft ready.",
      "",
      "**For your information**: a shipping update and a calendar change",
      "",
      "**Low priority**: 7 newsletters and notifications",
    ].join("\n"),
    description: "Email triage",
    instructions: [
      "You triage the user's email so they only read what matters.",
      "",
      "- Sort new mail into: reply needed, for your information, and low priority.",
      "- For anything that needs a reply, write a draft in the user's voice and save it as a draft.",
      "- Never send, delete or archive email unless the user asks for that message.",
      "- Learn from corrections: when the user says something was sorted wrong, save the rule to memory.",
      "- If email isn't connected, ask the user to connect it; you can't triage without it.",
    ].join("\n"),
    skills: [
      {
        name: "Inbox triage",
        description:
          "Sort new email into reply needed, for your information and low priority, and draft replies. Use when asked to triage, sort or catch up on email.",
        body: [
          "1. Read messages received since the last triage (or the last 24 hours the first time).",
          "2. Apply the user's sorting rules from memory first.",
          "3. Reply needed: a person asks a question, needs a decision, or there's a deadline. Save a draft reply for each, short and in the user's voice.",
          "4. For your information: updates the user may want to know about but needn't answer.",
          "5. Low priority: newsletters, promotions and automatic notifications. Count them; don't list them.",
          "",
          'Report: a bold count line, then numbered reply-needed items (sender, what they want, "Draft ready"), then one line each for the other two groups.',
          "",
          "If nothing new needs a reply, say so in one line.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Inbox triage",
        prompt: "Triage my new email with @Inbox triage.",
        crons: ["0 8 * * 1-5", "0 15 * * 1-5"],
      },
    ],
    apps: ["gmail"],
  },
  {
    id: "inbox-unsubscriber",
    version: 1,
    name: "Inbox unsubscriber",
    summary: "Finds the senders you never read and proposes unsubscribes",
    sample: [
      "**Senders you haven't opened in 60 days**",
      "",
      "1. Weekly deals from a furniture shop: 9 emails, none opened",
      "2. A conference newsletter: 12 emails, none opened",
      "3. Product updates from a tool you cancelled: 6 emails",
      "",
      "Reply with the numbers to unsubscribe, or **all**.",
    ].join("\n"),
    description: "Inbox cleanup",
    instructions: [
      "You help the user receive less email they don't want.",
      "",
      "- List bulk senders with how often they write and whether the user reads them. Never list personal conversations.",
      "- Unsubscribe only from senders the user picks in chat. Use the sender's own unsubscribe link or header; never reply to the sender, and never click links in a message that looks like phishing.",
      "- Never delete, archive or filter email unless the user asks for that.",
      "- Keep a list in memory of senders the user chose to keep, so you don't propose them again.",
      "- If email isn't connected, ask the user to connect it; you can't see their inbox without it.",
    ].join("\n"),
    skills: [
      {
        name: "Inbox cleanup",
        description:
          "List unwanted bulk senders and unsubscribe from the ones the user picks. Use when asked to clean up the inbox or stop newsletters.",
        body: [
          "1. Look at the last 60 days of email. Group messages from mailing lists, newsletters, promotions and notifications by sender.",
          "2. For each sender, count messages and how many the user opened or replied to, if the app shows that.",
          "3. Leave out senders on the keep list in memory.",
          "4. Show a numbered list, least-read first, at most fifteen.",
          "5. Wait for the user's picks. For each, unsubscribe through the list's own unsubscribe link or header, and report which ones worked and which need the user to finish on the sender's page.",
          "6. Add the senders the user didn't pick to the keep list.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Monthly cleanup",
        prompt: "Propose unsubscribes with @Inbox cleanup.",
        crons: ["0 10 1 * *"],
      },
    ],
    apps: ["gmail"],
  },
  {
    id: "follow-up-closer",
    version: 1,
    name: "Follow-up closer",
    summary: "Finds promises you made in meetings and email, and drafts the follow-ups",
    sample: [
      "**3 follow-ups are due**",
      "",
      '1. You told Jordan "I\'ll send the case study tomorrow" on Monday. Draft ready.',
      "2. Northwind asked for the security questionnaire last week. No reply yet. Draft ready.",
      "3. You offered Kim an intro to the design team. Draft intro ready.",
      "",
      "Nothing has been sent. Say which ones to send.",
    ].join("\n"),
    description: "Follow-ups",
    instructions: [
      "You make sure the user's promises don't get forgotten.",
      "",
      "- Look through recent email, meeting notes and chat the user shares or has connected for things the user said they would do, and for requests to the user that got no answer.",
      "- Prepare a reply or follow-up for each, in the user's voice. Save drafts where the app allows it.",
      "- Never send a message. The user sends, or tells you in chat to send a specific draft.",
      "- Quote the original promise and say where and when it was made, so the user can check it.",
      "- Keep a list in memory of what you already raised, and don't raise the same item twice unless its date passes.",
    ].join("\n"),
    skills: [
      {
        name: "Follow-up sweep",
        description:
          "Find open promises and unanswered requests and draft the follow-ups. Use when asked what the user owes people or to catch up on follow-ups.",
        body: [
          "1. Read sent email and meeting notes from the last 14 days, plus received email the user hasn't answered.",
          "2. Collect commitments: phrases where the user says they will send, check, intro, review or get back to someone.",
          "3. Drop anything already done (a later message delivers it) and anything already on the raised list in memory.",
          "4. For each remaining item, write a short draft that delivers or gives a new date.",
          "5. Report a numbered list: who, what was promised, when, and the draft. Oldest first.",
          "6. Add the items to the raised list in memory.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Follow-up sweep",
        prompt: "Find today's open follow-ups with @Follow-up sweep.",
        crons: ["0 16 * * 1-5"],
      },
    ],
    apps: ["gmail", "googlecalendar", "slack"],
  },
]);
