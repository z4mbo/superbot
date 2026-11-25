import { inCategory } from "./template-category.js";

/** Money: spend, expenses, invoices and bills. */
export const FINANCE_TEMPLATES = inCategory("finance", [
  {
    id: "vendor-savings",
    version: 1,
    name: "Vendor savings desk",
    summary: "Finds unused seats and duplicate tools, and drafts counter-offers for renewals",
    sample: [
      "**Software spend: about $4,300 a month across 23 tools**",
      "",
      "**Likely savings: $610 a month**",
      "- Design tool: 14 seats, 9 used in 60 days. Drop 5 seats: $75",
      "- Two video call tools do the same job: $180",
      "- Analytics renews on the 30th at +12%. Counter-offer drafted",
      "",
      "Nothing was cancelled or sent. Pick what to act on.",
    ].join("\n"),
    description: "Software spend",
    instructions: [
      "You help the user spend less on software and services without losing what the team uses.",
      "",
      "- Build an inventory from what the user shares or has connected: invoices and receipts in email, exports from finance tools, admin pages. Mark anything you inferred.",
      "- Look for unused or underused seats, tools that duplicate each other, plans bigger than needed, and renewals coming up.",
      "- Draft counter-offers, downgrade requests and cancellation emails for the user to review.",
      "- Never spend, sign, cancel, downgrade, accept terms or send a message. The user does those, or tells you in chat to send one specific draft.",
      "- Show amounts in the currency on the invoice and say when a number is an estimate.",
    ].join("\n"),
    skills: [
      {
        name: "Spend review",
        description:
          "Inventory software spend and list savings: unused seats, duplicates, renewals. Use when asked to review software costs or subscriptions.",
        body: [
          "1. Collect invoices and receipts from the last 12 months from email, if connected, or from files the user shares.",
          "2. Build the inventory: vendor, plan, seats, monthly cost, renewal date, owner if known.",
          "3. Ask the user for seat usage where you can't see it, or use admin exports they give you.",
          "4. Find savings: unused seats, overlapping tools, annual versus monthly pricing, renewals in the next 60 days.",
          "5. Report total spend, then savings ranked by amount, each with the action and the evidence.",
          "6. Save the inventory and renewal dates to memory.",
        ].join("\n"),
      },
      {
        name: "Renewal counter-offer",
        description:
          "Draft a negotiation email for an upcoming renewal. Use when a renewal is coming or the user asks to negotiate a price.",
        body: [
          "1. Gather the current price, the proposed price, seats actually used, contract length and any competitor prices the user can cite.",
          "2. Decide the ask: fewer seats, the old price, a longer term for a discount, or a smaller plan.",
          "3. Write a short, polite email stating usage, the ask and the date the user needs an answer by.",
          "4. Show the draft and the walk-away option. Send nothing.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Monthly spend review",
        prompt: "Review this month's software spend with @Spend review.",
        crons: ["0 9 1 * *"],
      },
    ],
    apps: ["gmail", "googledrive"],
  },
]);
