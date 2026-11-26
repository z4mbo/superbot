/**
 * What a task thread's helper is told besides its brief. The person reads the conversation that
 * started the task, not the thread, so the final message is written to stand on its own there.
 */
export const TASK_THREAD_INSTRUCTIONS =
  "This task runs in a thread of its own that the person can open, so your conversation with them stays short. Do the work here with your tools and finish it. Your last message is your report: it goes back to that conversation, so give the answer itself, with the facts, figures, dates and links asked for, sized to the question, then anything you could not confirm, a sentence each. Leave out how you got there: no account of what you searched, read or checked.";

/** Added for a follow-up, whose brief is read against the work earlier in the thread. */
export const TASK_THREAD_FOLLOW_UP_INSTRUCTIONS = `${TASK_THREAD_INSTRUCTIONS} This is a follow-up to the work earlier in this thread: change or add to that work as it asks.`;

export function taskThreadStartedNote(title: string) {
  return `Task "${title}" is working in its own thread, and its result comes back to this conversation. Do not do the work yourself or wait for it: end your turn when nothing else needs doing. Give the person the link only if they ask for it.`;
}

export const TASK_THREAD_NOT_FOUND =
  "This conversation started no open task thread with that id. Call link_to_thread to find it; never act on another task in its place.";

export const TASK_THREAD_STILL_WORKING =
  "That task is still working, so nothing was sent. Its result comes back here; follow it up once it has, or stop_task it and delegate the whole task again.";

export function taskThreadStoppedNote(title: string, stopped: boolean) {
  return stopped
    ? `Stopped task "${title}". Anything it already did stays done.`
    : `Task "${title}" was not working, so there was nothing to stop.`;
}

export const CHECK_IN_ALREADY_DISMISSED =
  "The person already turned this check-in down in this conversation. Do not offer it again.";

export const CHECK_IN_NEEDS_AN_ANSWER =
  "A check-in offer needs the person's answer, and this space never asks. Offer it in words instead, and set it up with schedule_create only if they say yes.";

/** What a check-in routine does each time it runs, from what the person accepted. */
export function checkInPrompt(subject: string, prompt: string) {
  return `Check in on ${subject} for the person. ${prompt}`.trim();
}

/** The run instructions' line on task threads, given only to a run that holds delegate. */
export const TASK_THREADS_INSTRUCTION =
  "delegate hands work the person asked for (research, making something, anything in an app or on a website) into a task thread of its own and returns at once, so you keep answering here. Say in one line what you will do, then call it with a brief that stands on its own; do not do the work yourself as well. Its result comes back to this conversation. When the person adds to or changes a task's work, use follow_up with its threadId; when they ask to stop one, stop_task only the task they mean; when they ask for its link, link_to_thread. A new piece of work is a new task, even when they say also. A routine or reminder for this conversation is set up here, never in a task.";
