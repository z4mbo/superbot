import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { GeneratedMediaSchema } from "./message-blocks.js";
import { threadTarget } from "./thread-send.js";

const state = z.enum(["unread", "read", "done"]);
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: Id }),
  z.object({ kind: z.literal("group"), groupId: Id }),
  z.object({ kind: z.literal("botConversation"), botId: Id, threadId: Id }),
]);

const inboxItem = z.object({
  id: Id,
  kind: z.enum(["active", "question", "result"]),
  state,
  target,
  messageId: Id.nullable(),
  runId: Id,
  botId: Id,
  title: z.string(),
  updatedAt: z.iso.datetime(),
});

const libraryItem = z.object({
  id: Id,
  kind: z.enum(["artifact", "page", "app"]),
  title: z.string(),
  messageId: Id.nullable(),
  authorUserId: Id.nullable(),
  authorBotId: Id.nullable(),
  mimeType: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Set on an image or video a media tool made. */
  generated: GeneratedMediaSchema.optional(),
});

export const conversationContentRpc = {
  inbox: {
    list: oc.input(z.object({ includeDone: z.boolean() })).output(z.array(inboxItem)),
    setState: oc.input(z.object({ id: Id, state })).output(z.object({ ok: z.literal(true) })),
  },
  conversationLibrary: {
    list: oc.input(threadTarget).output(z.array(libraryItem)),
  },
};
