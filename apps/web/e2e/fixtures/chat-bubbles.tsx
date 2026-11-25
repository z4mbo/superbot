import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import "../../src/styles.css";
import { BOT, FixtureTranscript } from "./thread-fixture";

// Runs from both sides, a quoted reply and a long reply; `?running=1` holds a run in progress.
const params = new URLSearchParams(location.search);
const running = params.get("running") === "1";
const lines: [ThreadMessage["role"], string][] = [
  ["user", "What did we decide about the beta invite list?"],
  ["bot", "We kept it to the forty teams from the pilot, plus anyone who reported a bug."],
  ["bot", "I can send the invites tomorrow morning."],
  ["user", "Tomorrow morning works."],
  ["bot", "Scheduled for 8:30."],
  ["user", "Can you plan the launch checklist for Thursday?"],
  ["user", "Keep it short, the team reads it on phones."],
  ["user", "And put owners first."],
  ["bot", "Sure. I'll group it by owner so everyone sees their part first."],
  ["bot", "Design signs off the screenshots and engineering tags the release by noon."],
  ["bot", "Want me to add the rollback steps too?"],
  ["user", "Yes, add them under engineering."],
  [
    "bot",
    "Done. Engineering now has three rollback steps: pause the rollout, restore the previous build from the release tag, and post a short note in the launch channel so support knows what changed.\n\nI also moved the database backup to Wednesday evening, so a rollback never has to wait for it.",
  ],
  ["user", "Perfect. Can you check whether the help pages are ready?"],
];
const start = Date.parse("2026-08-16T09:00:00.000Z");
const messages: ThreadMessage[] = lines.map(([role, text], index) => ({
  id: `m${index + 1}`,
  threadId: "thread-1",
  seq: index + 1,
  role,
  // Your own messages carry your id, so a run of them groups the way the app groups it.
  ...(role === "bot" ? { botId: BOT.botId } : { author: { id: "user-1", name: "Sam" } }),
  blocks: [{ kind: "text", text }],
  createdAt: new Date(start + index * 20_000).toISOString(),
}));
// The long reply quotes the message it answers.
const reply = messages[12]!;
reply.replyToMessageId = "m12";
reply.replyPreview = { role: "user", text: "Yes, add them under engineering." };

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript messages={messages} running={running} showToolActivity={false} />
    </I18nProvider>,
  );
});
