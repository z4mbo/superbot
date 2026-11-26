# Routines

A routine is a prompt a bot runs on its own: on a schedule, when something changes, or when another
service calls it.

## Ask for one in chat

The quickest way is to ask:

- "Every weekday at 8am, summarize my inbox."
- "Remind me in 20 minutes to call Dana."
- "Every Monday, check our competitors' pricing pages and tell me what changed."

The bot creates the routine and reports each run back in the same chat.

A bot may also offer to check in on something you discussed. The offer is a card: **Set it up**
creates the routine, and **No thanks** creates nothing and the bot doesn't offer it again in that
chat.

## Create or edit one yourself

On web or desktop, click the bot's name at the top of its chat to open the bot panel. In
**Routines**, choose **New routine** if the list is empty, or **+** (labeled **Create routine**) if
it already has routines. To edit a routine, select it from the list.

1. **Name** the routine and write the **Instruction**: what it should do each time it runs.
2. Under **When to run**, choose **Add trigger**.
3. Choose **Save**.

Under **Advanced** you can give a routine its own **Model** and **Thinking** level, for example a
cheaper model for a simple daily check.

## Triggers

### On a schedule

Every hour, every day, weekdays, every week, every month, or a custom interval. **Advanced...**
accepts a cron expression. Times use your timezone, set in **Settings → General**.

### When something changes

The bot checks something at a set interval (**Check every**, from 5 minutes to a day) and runs only
when it changed. **What to watch** can be files or folders on the computer, a command's output, or a
tool from a connected app. A tool's arguments can hold a date that moves with the calendar: ask the
bot to watch, say, what is due before `{{today+2d}}`. Turn on **Post "No changes" in chat** if you want a note every time. A
watch can't be combined with a schedule.

### Webhook

Gives you a URL and key. Any service that can send a POST request can start the routine.

### App event

Runs when something happens in an app you connected in **Plugins**: a new issue, pull request or
commit in a GitHub repository, or a new Gmail message. Pick the app, the event and, where it asks,
the repository; with more than one account of the app connected, pick the account too. The server
sets up the subscription with the app for you when you save, removes it when you pause or delete
the routine, and stops it if you disconnect the app (the routine then says to reconnect). Each
event starts one run, even when the app sends it again.

Your server's integration provider delivers events the moment they happen when its operator set up
event delivery ([self-hosting](./self-host-integrations.md#app-events)). Otherwise the routine
checks the app every 5 minutes instead, like a change trigger, so it can't be combined with a
schedule or another change trigger.

You can also ask in chat: "When someone opens an issue in octo/hello, triage it."

### Git event

Gives you a URL to add as a GitHub webhook, so pushes, issues and pull requests from any repository
it is added to can start the routine. Use an app event instead to pick the repository and events
without editing GitHub's settings.

### Email

Runs when mail arrives at the bot's own address, such as `scout@bots.example.com`. The first
time, pick the part before the @; it stays the bot's for good. Forward or CC mail to it, by hand
or with a mailbox rule, and the routine runs with that email. A rule has to forward, not redirect:
redirected mail keeps its original sender and recipients, so it never names the bot. Choose who can start it: **Only me**, or **Anyone at** your own
email domain. Mail from anyone else, and mail sent BCC, starts nothing, but the bot keeps every
email in its inbox either way. If mail from your own address can't be verified, the chat says so;
your email provider then needs DKIM signing turned on for your domain. Appears only when your
server [receives email](./self-host-inbound-email.md).

### Slack message

Runs when the bot receives a message in Slack. Needs [Slack connected](./messaging-apps.md).

> [!NOTE]
> A routine run started by a webhook, an app event, an email or a Slack message follows your
> [approval](./approvals.md) mode and Always allow list. Since outside text could steer it, tools
> that change something are checked even if they never ask in your own chats. Nobody may be
> watching, so an approval card it posts expires after 30 minutes by default and the action isn't done.
> `UNATTENDED_APPROVAL_EXPIRE_AFTER_MS` changes that window. Always allow on a
> tool such as shell or the browser lets outside text use it freely.

## Test, pause and review

- **Test run** runs a saved routine now.
- Turn off **Active** to pause a routine without deleting it.
- **Run history** shows each past run and its result.
- A running routine shows **Running** in the list, with **Stop**.

## On mobile

The mobile app lists a bot's routines from its profile. Tap **+** to create one. Tapping a routine
shows its instruction, schedule, next run and run history, with a switch to pause it and a button to
test it; **Edit routine** changes its name, instruction and schedules, or deletes it. Webhook, Git event, app
event, Slack message and change triggers, and a routine's own model, are set up in chat or the web
or desktop app; mobile shows them, keeps them as they are, and can remove them.
