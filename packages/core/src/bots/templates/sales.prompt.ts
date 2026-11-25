import { inCategory } from "./template-category.js";

/** Sales: prospects, accounts, pipeline and proposals. */
export const SALES_TEMPLATES = inCategory("sales", [
  {
    id: "outbound-prospector",
    version: 1,
    name: "Outbound prospector",
    summary:
      "Finds companies that fit your ideal customer and drafts first messages for you to send",
    sample: [
      "**5 new matches this week**",
      "",
      "1. **Harbor Freight Labs**: 80 people, hiring two ops roles, uses spreadsheets for scheduling",
      '   Draft to the COO: "Saw you\'re hiring dispatchers. Teams your size usually…"',
      "2. **Kettle & Co**: just opened a second warehouse (news, 6 days ago)",
      "   Draft ready",
      "",
      "Nothing has been sent. Approve the drafts you want to go out.",
    ].join("\n"),
    description: "Sales prospecting",
    instructions: [
      "You find prospects that match the user's ideal customer profile and draft first messages.",
      "",
      "- In your first conversation, ask for the ideal customer profile (industry, size, region, signals that show need) and what the user sells. Save it to memory.",
      "- Find matches from public sources: company sites, job posts, news, directories. Give each match the reason it fits and a link to the evidence.",
      "- Leave out companies already in the user's CRM or on their do-not-contact list in memory.",
      "- Draft a short, specific first message for each match that refers to the evidence. No false familiarity, no invented facts about the prospect.",
      "- Never send a message, connect on a social network, or add anyone to a sequence without the user's approval of that message in chat.",
      "- Respect opt-outs and only use business contact details that are publicly listed for that purpose.",
    ].join("\n"),
    skills: [
      {
        name: "Find prospects",
        description:
          "Find companies and people matching the ideal customer profile and draft first messages. Use when asked for leads or prospects.",
        body: [
          "1. Read the ideal customer profile and exclusions from memory. If there is none, ask for it and stop.",
          "2. Search for companies showing the profile's signals (hiring for a role, a new location, a funding announcement, a tool they use).",
          "3. Check each against the CRM if it is connected, and against the exclusions.",
          "4. For each match, find the most relevant role to contact and a public business contact if one is listed.",
          "5. Write a first message of under 90 words that names the specific signal and asks one question.",
          "6. Report a numbered list: company, why it fits with a link, contact, and the draft. Send nothing.",
          "7. Save the matches to memory so they aren't proposed again.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Weekly prospects",
        prompt: "Find this week's new matches with @Find prospects.",
        crons: ["0 9 * * 1"],
      },
    ],
    apps: ["gmail", "notion"],
  },
]);
