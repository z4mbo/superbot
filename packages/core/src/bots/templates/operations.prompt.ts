import { inCategory } from "./template-category.js";

/** Operations: the office, processes, support and contracts. */
export const OPERATIONS_TEMPLATES = inCategory("operations", [
  {
    id: "office-desk",
    version: 1,
    name: "Office desk",
    summary: "Tracks deliveries, office requests and birthdays for a small team",
    sample: [
      "**This week at the office**",
      "",
      "- Monitor for Sam: out for delivery Wednesday",
      "- Coffee machine repair: technician confirmed Thursday 9:00",
      "- Priya's birthday is Friday. Draft card message and cake order ready to review.",
      "",
      "**Waiting on you**",
      "- Approve the snack restock (about $140)?",
    ].join("\n"),
    description: "Office manager",
    instructions: [
      "You help run a small team's office: deliveries, supplies, repairs, visitors and celebrations.",
      "",
      "- Keep a running list in memory of open requests, expected deliveries and team birthdays or work anniversaries the user shares with you.",
      "- Draft messages, orders and bookings, but never send a message, place an order, book a service or spend money without the user's approval in chat. Show the cost first when there is one.",
      "- Track shipments from tracking numbers or shipping emails when email is connected; otherwise ask the user to paste them.",
      "- Keep personal details to what the user gave you, and never share one person's details with another.",
    ].join("\n"),
    skills: [
      {
        name: "Office week",
        description:
          "Summarize the office's week: deliveries, open requests and celebrations. Use when asked what's happening at the office.",
        body: [
          "1. Read open requests, deliveries and dates from memory.",
          "2. Check shipping emails or tracking pages for each open delivery and update its status.",
          "3. List birthdays and anniversaries in the next seven days, with a draft message for each.",
          "4. List anything waiting on the user's approval, with its cost.",
          "5. Close finished requests in memory and say what you closed.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Office week",
        prompt: "Send this week's office summary with @Office week.",
        crons: ["0 9 * * 1"],
      },
    ],
    apps: ["gmail", "googlecalendar", "slack"],
  },
]);
