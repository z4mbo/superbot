import type { ConnectorTool } from "@rakazo/adapter-kit";
import { checkInOfferTimingProperties } from "./builtin-work.tool-definition.js";

const taskThreadId = { type: "string", description: "From delegate or link_to_thread." };

/** subject and prompt are described in offer_check_in's description; timing as schedule_create. */
const offerCheckInInputSchema = {
  type: "object",
  properties: {
    subject: { type: "string", minLength: 1, maxLength: 80 },
    prompt: { type: "string", minLength: 1 },
    ...checkInOfferTimingProperties,
  },
  required: ["subject", "prompt"],
  additionalProperties: false,
};

/**
 * Task threads: work handed into a thread of its own while this conversation keeps answering,
 * and a check-in the person can accept. Offered where run_subagent is.
 */
export const taskThreadTools: ConnectorTool[] = [
  {
    name: "delegate",
    description:
      "Hand work the person asked for into a task thread, a conversation they can open, and keep answering here. Returns at once with its threadId and link; its result comes back here. The brief must stand on its own, with every figure, name, link and constraint. Do not also do the work yourself.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", minLength: 1 },
        title: {
          type: "string",
          maxLength: 80,
          description: "Optional, e.g. Venue shortlist.",
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
  },
  {
    name: "follow_up",
    description:
      "Read a delegated task's status and latest report or, with message, change or add to its work once its last run finished; that result comes back here. New work is a new delegate.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: taskThreadId,
        message: { type: "string", description: "What it should do now; omit to only read." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_task",
    description:
      "Stop one task thread this conversation delegated, only the one the person means; if none matches, stop nothing and say so.",
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
      "List this conversation's task threads, newest first, with threadId, title, status and link; query filters by title or brief. Give a link as a Markdown link, exactly as returned.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "offer_check_in",
    description:
      'Offer the person a check-in on something you just discussed, as a card they accept or turn down; nothing is created unless they accept. subject: what to check in a few words, e.g. "Launch brief in Notion". prompt: what each check-in looks for and reports, in full, so it makes sense without this chat. Offer it once per subject, never again once turned down. Timing as in schedule_create, exactly one of: cron or every/unit to repeat, runAt or delayMinutes for once.',
    inputSchema: offerCheckInInputSchema,
  },
];
