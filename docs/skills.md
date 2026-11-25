# Skills

A skill is written know-how a bot follows for a specific task, such as how you want expenses filed
or how to publish a blog post.

## Use a skill

Bots pick up the right skill on their own when a task matches it. To use one explicitly, type **/**
at the start of a message and choose it.

## Your skills library

Open the **Store** from the sidebar and choose **Skills**. The Store's other sections are
**Agents** (ready-made bots), **Apps** (apps and plugins you install) and **Connections** (the
accounts your bots can use).

- **Your skills** lists skills you or your bots have saved.
- **Plugins** lists skill sets you've added from plugins.
- **Browse** finds ready-made skills: Superbot's own library first, then skill packs from plugin
  registries. Search to narrow the list.

Skills you add are available to all your bots in the space.

### Superbot's skill library

Superbot ships a library of everyday skills you can add with one click. Open one in **Browse** to
read its steps, then choose **Add skill**. It's saved as your own skill, so you can edit it like any
other. The library covers:

- **Everyday work**: Schedule a meeting, Weekly planning, Clean up the inbox, Draft an email,
  Meeting notes, News briefing, Research a question, Write a document.
- **Errands and purchases**: Shop and compare, Careful purchase, Grocery list, Order food, Book a
  restaurant, Restaurant picks, Local businesses, Orders and returns, Manage subscriptions, Request
  a ride.
- **Travel and work**: Find flights, Find a stay, Travel itinerary, Search for jobs, Find leads,
  Enrich a lead, Markets and filings, Code review, Data broker opt-out.

Every library skill asks for what it needs, works with whatever tools the bot has, and stops for
your approval before it buys, books, sends a message or does anything it can't undo.

**Interrogate**, an adversarial review of a change or plan, is built in: every bot has it without
adding it.

Ready-made bots are in the Store's **Agents** section. Search them or filter by category, then open
one to see its instructions, skills and routines before you create it. Choose **New skill** to write one yourself: a name,
a short description of when to use it, and the steps.

You can add a skill catalog or one skill folder from GitHub: choose **From GitHub**, paste the
repository or folder URL, then **Preview** and **Add**. Adding a catalog installs all supported
skills in one action.

> [!NOTE]
> Skills added from GitHub or a plugin are instructions only. Any scripts they include are not run.

## Bots save skills too

After a multi-step task, ask the bot to "save that as a skill". It writes the skill so it, and your
other bots, can repeat the task next time. A skill a bot saves stays in the [space](./spaces.md) it
was made in.

## Teach a task by showing it

Some tasks are easier to show than describe.

1. In the bot's chat, select its name in the header to open the bot panel. Under **Computer**,
   choose **Open** on the preview (shown on hover or keyboard focus), or **Wake** if it is asleep.
2. Choose **Teach a task** and describe the result you will demonstrate, such as "Export this week's
   list from the CRM and drop it in the shared folder".
3. Choose **Start recording** and do the task on the bot's screen. The bot watches but does not act.
   Type passwords with **Protected input** so they are not recorded.
4. Choose **Stop teaching**.

The bot posts a **Draft skill** card with the steps it learned, when to use them, what to check, and
when to ask you first. Edit anything that's off, then choose **Save**. **Test** runs it once, and
**Add to routine** puts it on a schedule.

Teach a task is available on the web and desktop apps, not on mobile.
