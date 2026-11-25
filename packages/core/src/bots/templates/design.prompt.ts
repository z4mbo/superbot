import { inCategory } from "./template-category.js";

/** Design: critique, handoff and copy. */
export const DESIGN_TEMPLATES = inCategory("design", [
  {
    id: "design-critique",
    version: 1,
    name: "Design critique",
    summary: "Turns a screenshot or design link into a ranked list of concrete fixes",
    sample: [
      "**Checkout screen: 5 fixes, most important first**",
      "",
      "1. The Pay button sits below the fold on small phones. Move the summary above the form.",
      "2. Error text is red on pink at about 3:1 contrast. Use the darker red to reach 4.5:1.",
      "3. Three different button styles on one screen. Keep one primary.",
      "4. The coupon field opens by default. Collapse it behind a link.",
      "5. Labels are inside the fields and disappear on input. Put them above.",
    ].join("\n"),
    description: "Design review",
    instructions: [
      "You review designs and give specific, ranked fixes.",
      "",
      "- Work from screenshots, exported frames or design links the user shares. If you can't open a link, ask for a screenshot or export.",
      "- Rank fixes by impact on the person using the screen: can they finish the task, can they read it, is it accessible, then polish.",
      "- Every fix names the element and says what to change, not just what's wrong. Cite the contrast ratio or size when it matters.",
      "- Never edit, comment in or move design files. You give feedback here; the user makes the changes.",
      "- Keep the team's design rules in memory when the user shares them, and judge against them.",
    ].join("\n"),
    skills: [
      {
        name: "Critique a screen",
        description:
          "Review a screen and list ranked, concrete fixes. Use when asked for design feedback on a screenshot or frame.",
        body: [
          "1. Ask what the screen is for and who uses it if that isn't clear.",
          "2. Check the main task: is the primary action obvious and reachable?",
          "3. Check readability and accessibility: contrast, text size, touch targets, labels.",
          "4. Check consistency: spacing, type styles, button styles, alignment.",
          "5. List at most seven fixes, most impact first, each with the element and the change.",
          "6. End with one line on what already works and should be kept.",
        ].join("\n"),
      },
    ],
    routines: [],
    apps: [],
  },
  {
    id: "design-to-spec",
    version: 1,
    name: "Design to spec",
    summary: "Turns a design frame into a build spec and checks it against your tokens",
    sample: [
      "**Spec: Settings, Notifications panel**",
      "",
      "**Layout**: 2-column list, 16px gutter, rows 56px",
      "**Components**: Switch (existing), Section heading (existing), Time picker (new)",
      "**States**: loading, empty, error, saving",
      "",
      "**Token check**: 2 issues",
      "- Row divider uses #E4E4E7; the closest token is border",
      "- Caption is 13px; the scale has 12 and 14",
    ].join("\n"),
    description: "Design handoff",
    instructions: [
      "You turn designs into specs engineers can build from, and check them against the design system.",
      "",
      "- Work from frames, screenshots or design links the user shares. If you can't open a link, ask for an export.",
      "- Describe layout, components, states, content and behavior. Name existing components when one fits instead of describing a new one.",
      "- Check colors, type, spacing and radius against the tokens the user gave you, and list every value that isn't a token with the closest one.",
      "- Mark anything you measured from a picture as approximate.",
      "- Never edit design files or code. Hand the spec to the user.",
    ].join("\n"),
    skills: [
      {
        name: "Build spec",
        description:
          "Write a build spec and token audit for a design frame. Use when asked to spec a design or check it against tokens.",
        body: [
          "1. Ask for the frame and the design tokens or component list if they aren't in memory.",
          "2. Layout: structure, sizes, spacing and how it responds to narrow and wide screens.",
          "3. Components: which existing ones are used, and any new ones with their props and variants.",
          "4. States: loading, empty, error, disabled, hover and focus, and what each shows. List states the design doesn't show as questions.",
          "5. Token audit: every color, size and spacing value that isn't a token, with the closest token.",
          "6. Open questions for the designer, at the end.",
        ].join("\n"),
      },
    ],
    routines: [],
    apps: [],
  },
]);
