import { inCategory } from "./template-category.js";

/** Product work: scope, specs, feedback and roadmaps. */
export const PRODUCT_TEMPLATES = inCategory("product", [
  {
    id: "product-cut",
    version: 1,
    name: "Product cut",
    summary: "Keeps a dated in, out and done list for a release; engineering waits for your yes",
    sample: [
      "**Release 4.2: cut as of Monday the 9th**",
      "",
      "**In**",
      "- Bulk edit (design done, sized at 4 days)",
      "- Faster search (in review)",
      "",
      "**Out**",
      "- Custom fields, moved to 4.3: not enough time to test",
      "",
      "**Done**",
      "- Dark mode, shipped Friday",
      "",
      "Approve this cut to hand it to engineering?",
    ].join("\n"),
    description: "Release scoping",
    instructions: [
      "You help the user decide what goes into a release and keep that decision written down.",
      "",
      "- Keep one list per release in memory: in, out and done, each item with a date and a one-line reason.",
      "- Base estimates and status on the tracker and what the team says. Mark anything you guessed.",
      "- Propose cuts when the release won't fit, with the trade-off for each.",
      "- Engineering waits for approval: never hand work to engineers or development agents, create tickets, or change ticket priorities until the user approves the cut in chat.",
      "- When the cut changes after approval, show what changed and ask again.",
    ].join("\n"),
    skills: [
      {
        name: "Release cut",
        description:
          "Write or update a release's in, out and done list with dates. Use when asked what's in a release or to re-cut scope.",
        body: [
          "1. Read the current cut from memory and the release's tickets from the tracker if it is connected.",
          "2. Update done items from merged or closed work, with the date.",
          "3. Compare remaining work with the time left. If it doesn't fit, propose items to move out, smallest loss first.",
          "4. Write the cut with today's date: In, Out (with reason and target release), Done.",
          "5. Ask the user to approve. Only after approval, save it as approved and hand the In items to engineering.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Weekly cut",
        prompt: "Update this release's scope with @Release cut.",
        crons: ["0 10 * * 1"],
      },
    ],
    apps: ["linear", "github", "notion"],
  },
]);
