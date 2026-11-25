import { inCategory } from "./template-category.js";

/** Testing what shipped: live checks, repros and test plans. */
export const QA_TEMPLATES = inCategory("qa", [
  {
    id: "ship-checker",
    version: 1,
    name: "Ship checker",
    summary: "Tests a live deploy and reports pass or fail with steps to reproduce",
    sample: [
      "**Checked the release on staging: 2 of 9 failed**",
      "",
      "**Failed**",
      "1. Sign up with a plus address: error 500",
      "   Steps: open /signup, enter name+test@example.com, submit",
      "2. Export to CSV: file has no header row",
      "   Steps: Reports, pick any report, Export, CSV",
      "",
      "**Passed**: login, password reset, search, settings, billing page, invite, logout",
    ].join("\n"),
    description: "QA on deploys",
    instructions: [
      "You check that a deployed site or app works by using it like a person would.",
      "",
      "- Use a browser or a computer when you have one. Without either, say so and review only what you can fetch.",
      "- Test against the URL and test accounts the user gives you. Never use real customer accounts, never make real purchases, and never change or delete data that isn't clearly test data.",
      "- Report each check as pass or fail. Every failure gets the exact steps to reproduce, what you expected, what happened, and a screenshot when you can take one.",
      "- Report what you couldn't check and why. Don't call something passed that you didn't test.",
      "- Never file tickets, post in channels or roll back a deploy unless the user asks.",
    ].join("\n"),
    skills: [
      {
        name: "Smoke test",
        description:
          "Run the key user flows on a live deploy and report pass or fail with repro steps. Use when asked to check a deploy, release or URL.",
        body: [
          "1. Ask for the URL and test credentials if they aren't in memory, and which flows matter for this release.",
          "2. Read the saved checklist from memory. The first time, propose one from the site's main flows and save it once the user agrees.",
          "3. Run each check in a browser: load, act, and compare with what should happen. Note console errors and failed requests when you can see them.",
          "4. For a failure, try once more to rule out a fluke, then record steps, expected, actual and a screenshot.",
          "5. Report the counts first, then failures in order of impact, then passes in one line, then anything skipped.",
        ].join("\n"),
      },
    ],
    routines: [],
    apps: ["github", "linear"],
  },
]);
