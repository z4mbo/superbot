import type { MessageBlock } from "@rakazo/contracts";
import { chatAppAskText, chatAppTakeoverText, pageLinksAsTitles } from "@rakazo/core";

function textBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; text?: unknown } | null) =>
    block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Pages the run's replies already link by name, so their cards add nothing more. */
export function linkedPageIds(messages: readonly { blocks: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const text of textBlocks(message.blocks)) {
      // Only links the conversion names count; one inside a code example stays as written, so a
      // page counts when fewer of its links remain after converting than were written.
      const converted = pageLinksAsTitles(text);
      const count = (source: string, link: string) => source.split(link).length - 1;
      for (const match of text.matchAll(/\]\(page:([A-Za-z0-9_-]{1,64})\)/g))
        if (count(converted, match[0]) < count(text, match[0])) ids.add(match[1]!);
    }
  return ids;
}

/**
 * The text other channels get. A page card cannot travel, so a page the reply does not name goes
 * as its title. With `asks`, for a 1:1 chat, a pending question or takeover request goes as text
 * too, so the person learns the bot is waiting on them.
 */
export function extractText(
  blocks: unknown,
  linkedPages: ReadonlySet<string>,
  options: { asks?: boolean } = {},
): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap(
      (block: { kind?: unknown; text?: unknown; pageId?: unknown; title?: unknown } | null) => {
        if (block?.kind === "text" && typeof block.text === "string")
          return [pageLinksAsTitles(block.text)];
        if (options.asks && block?.kind === "ask") {
          const ask = chatAppAskText(block as MessageBlock);
          return ask ? [ask] : [];
        }
        if (options.asks && block?.kind === "computer") {
          const takeover = chatAppTakeoverText(block as Parameters<typeof chatAppTakeoverText>[0]);
          return takeover ? [takeover] : [];
        }
        if (
          block?.kind === "page" &&
          typeof block.title === "string" &&
          typeof block.pageId === "string" &&
          !linkedPages.has(block.pageId)
        )
          return [block.title];
        return [];
      },
    )
    .join("\n")
    .trim();
}

/** Everything a run's replies said, as one text for a channel that takes a single message. */
export function repliesText(messages: readonly { blocks: unknown }[]): string {
  const linkedPages = linkedPageIds(messages);
  return messages
    .map((message) => extractText(message.blocks, linkedPages))
    .filter(Boolean)
    .join("\n\n");
}
