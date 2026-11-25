/**
 * Copy for the Store and Apps platform sections of the home page. English only for now: translated
 * home pages show these sections in English and mark them `lang="en"` until they are translated.
 */
export const APPS_PLATFORM_COPY = {
  announcement: "Apps platform: build an app for the Store",
  nav: {
    store: "Store",
    buildAnApp: "Build an app",
  },
  store: {
    eyebrow: "The Store",
    heading: "Give your bots more to work with",
    copy: "Everything in the Store installs into a Space in a few clicks, and you choose which bots get it.",
    sections: [
      {
        id: "agents",
        title: "Agents",
        body: "Premade agents set up for a real job. Install one, connect what it needs, and change anything.",
        examples: ["Research", "Outbound", "QA", "Meeting recaps", "Travel", "Inbox"],
      },
      {
        id: "skills",
        title: "Skills",
        body: "A library of instructions that teach a bot how to do one thing well. Add them to any bot.",
        examples: ["Writing", "Reports", "Code review", "Planning"],
      },
      {
        id: "apps",
        title: "Apps",
        body: "Apps that developers build and publish: their own data, tools for the bot and cards in chat.",
        examples: ["Food Diary", "Trackers", "Logs", "Dashboards"],
      },
      {
        id: "connections",
        title: "Connections",
        body: "Sign in to the services you already use so bots can read and act there, with your approval.",
        examples: ["GitHub", "Gmail", "Stripe", "Any MCP server"],
      },
    ],
  },
  platform: {
    eyebrow: "Apps platform",
    heading: "Build an app your bots can use",
    copy: "An app is a small product that lives inside Superbot. You write it; Superbot hosts it, keeps its data and puts it in front of people and their bots.",
    capabilities: [
      {
        id: "data",
        title: "Hosted data",
        body: "Each install gets its own records, stored by Superbot. No database to run.",
      },
      {
        id: "functions",
        title: "Backend functions",
        body: "Server code that runs on Superbot when a person or a bot uses the app.",
      },
      {
        id: "permissions",
        title: "Permissions people approve",
        body: "The app lists what it needs, down to the outside hosts it may call. People see the list before they install.",
      },
      {
        id: "tools",
        title: "Tools for the bot",
        body: "Declare tools and a granted bot can call them in conversation.",
      },
      {
        id: "cards",
        title: "Cards in chat",
        body: "Forms and summaries render right in the conversation, for people and bots alike.",
      },
    ],
    steps: [
      { title: "Build", body: "Start from the guide, or hand the prompt to your coding agent." },
      {
        title: "Publish",
        body: "Submit a version. Every version is reviewed before it is listed.",
      },
      { title: "Install", body: "People install it from the Store and grant it to their bots." },
    ],
    example: {
      eyebrow: "Example",
      heading: "Food Diary",
      copy: "Install Food Diary and the bot can keep the log for you: you add a meal with a form card, the bot reads the day and adds what you tell it, and a summary card shows the day's total.",
      chat: {
        install: "Food Diary installed",
        installDetail: "Granted to Nutrition coach",
        formTitle: "Log food",
        fields: [
          { label: "Meal", value: "Porridge with berries" },
          { label: "Calories", value: "420" },
        ],
        save: "Save",
        ask: "I also had a banana and a coffee with milk. What's my total today?",
        reply: "Added both. You're at 1,180 kcal today, with dinner still to log.",
        toolCall: "Food Diary · add entries",
        summaryTitle: "Today",
        summaryRows: [
          { label: "Breakfast", value: "420 kcal" },
          { label: "Lunch", value: "610 kcal" },
          { label: "Snacks", value: "150 kcal" },
        ],
        summaryTotal: { label: "Total", value: "1,180 kcal" },
        coach: "Nutrition coach",
        you: "You",
        exampleData: "Example data",
      },
    },
    cta: {
      heading: "Start with one prompt",
      copy: "Copy the prompt into Claude Code, Codex, ChatGPT or Cursor. It points your agent at the guide and walks you through your first app.",
      readGuide: "Read the guide",
    },
  },
  footer: {
    developers: "Developers",
    publish: "Publish to the Store",
    builtOn: "Built on",
  },
  copyPrompt: {
    label: "Copy the Build an app prompt",
    copied: "Copied",
    failed: "Copy failed. Select the prompt below.",
    show: "Show the prompt",
    plainText: "Plain text",
  },
} as const;
