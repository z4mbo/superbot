import type { ConnectorTool } from "@rakazo/adapter-kit";
import { checkInOfferBranch } from "./builtin-work.tool-definition.js";

const taskThreadId = {
  type: "string",
  description: "The task's threadId, as delegate or link_to_thread gave it.",
};

const checkInProperties = {
  subject: {
    type: "string",
    minLength: 1,
    maxLength: 80,
    description:
      'What to check, in a few words the person reads on the offer and in Routines, e.g. "Launch brief in Notion".',
  },
  prompt: {
    type: "string",
    minLength: 1,
    description:
      "What each check-in looks for and how it reports, in full, written so it makes sense without this chat.",
  },
};

/** Exactly one timing method, as schedule_create takes it. */
const offerCheckInInputSchema = {
  oneOf: [
    checkInOfferBranch(["cron"], checkInProperties),
    checkInOfferBranch(["every", "unit"], checkInProperties),
    checkInOfferBranch(["runAt"], checkInProperties),
    checkInOfferBranch(["delayMinutes"], checkInProperties),
  ],
};

/**
 * Task threads: work handed into a thread of its own while this conversation keeps answering,
 * and a check-in the person can accept. Offered where run_subagent is.
 */
export const taskThreadTools: ConnectorTool[] = [
  {
    name: "delegate",
    description:
      "Hand work the person asked for into a task thread of your own, a conversation they can open, and keep answering here. Returns at once with its threadId and link; its result comes back to this conversation. Write the brief so it stands on its own: every figure, name, link and constraint the work needs. Do not also do the work yourself.",
    inputSchema: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          minLength: 1,
          description: "The whole task, as the work needs it.",
        },
        title: {
          type: "string",
          maxLength: 80,
          description: "Optional short title for the thread, e.g. Venue shortlist.",
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
  },
  {
    name: "follow_up",
    description:
      "Change or add to the work of a task this conversation started with delegate, once its last run has finished; the result comes back here. A new piece of work is a new delegate, not a follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: taskThreadId,
        message: { type: "string", minLength: 1, description: "What the task should do now." },
      },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_task",
    description:
      "Stop the work in one task thread this conversation started with delegate. Stop only the task the person means; if none of this conversation's tasks matches, stop nothing and say so.",
    inputSchema: {
      type: "object",
      properties: { threadId: taskThreadId },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "link_to_thread",
    description:
      "List the task threads this conversation started, newest first, with their threadId, title, status (running, finished, stopped or failed) and link. query narrows them by title or brief. Give the person a link as a Markdown link, exactly as it comes back.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words from the task's title or brief." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "offer_check_in",
    description:
      "Offer the person a check-in on something you just discussed: a card they can accept or turn down. It creates nothing unless they accept, which sets up the routine. Offer it at most once per subject; when they turn it down, do not offer it again. Timing as in schedule_create: cron or every/unit to repeat, runAt or delayMinutes for once.",
    inputSchema: offerCheckInInputSchema,
  },
];
