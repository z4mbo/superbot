import type { Actor, RpcOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { LISTED_ARTIFACT } from "@rakazo/db";
import { loadMessagePage } from "./thread-message-pages.js";

type Item = RpcOutput<"conversationLibrary/list">[number];
const historyLimit = 500;
const libraryLimit = 100;

export async function conversationLibrary(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<Item[]> {
  const { messages } = await loadMessagePage(
    prisma,
    threadId,
    undefined,
    historyLimit,
    undefined,
    false,
    true,
  );
  const references = messages.reverse().flatMap((message) =>
    message.blocks.flatMap((block, index) => {
      if (
        block.kind !== "app" &&
        block.kind !== "page" &&
        block.kind !== "image" &&
        block.kind !== "file"
      )
        return [];
      return [{ message, block, index }];
    }),
  );
  const artifactIds = references.flatMap(({ block }) =>
    block.kind === "image" || block.kind === "file" ? [block.artifactId] : [],
  );
  const pageIds = references.flatMap(({ block }) => (block.kind === "page" ? [block.pageId] : []));
  const appRunIds = references.flatMap(({ message, block }) =>
    block.kind === "app" && message.role === "bot" && message.runId ? [message.runId] : [],
  );
  const [artifacts, pages, appRuns] = await Promise.all([
    prisma.artifact.findMany({
      where: { spaceId: actor.spaceId, id: { in: artifactIds }, ...LISTED_ARTIFACT },
      select: {
        id: true,
        name: true,
        userId: true,
        botId: true,
        runId: true,
        mimeType: true,
        createdAt: true,
      },
    }),
    prisma.page.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, id: { in: pageIds } },
      select: { id: true, title: true, userId: true, botId: true, createdAt: true },
    }),
    prisma.run.findMany({
      where: { spaceId: actor.spaceId, threadId, userId: actor.userId, id: { in: appRunIds } },
      select: { id: true, userId: true, botId: true },
    }),
  ]);
  const artifactById = new Map(artifacts.map((row) => [row.id, row]));
  const pageById = new Map(pages.map((row) => [row.id, row]));
  const appRunById = new Map(appRuns.map((row) => [row.id, row]));
  const items = new Map<string, Item>();
  for (const { message, block, index } of references) {
    const kind = block.kind === "page" || block.kind === "app" ? block.kind : "artifact";
    const id =
      block.kind === "page"
        ? block.pageId
        : block.kind === "app"
          ? `${message.id}:${index}`
          : block.artifactId;
    const key = `${kind}:${id}`;
    if (items.has(key)) continue;
    if (block.kind === "app") {
      const run =
        message.role === "bot" && message.runId ? appRunById.get(message.runId) : undefined;
      if (!run) continue;
      items.set(key, {
        id,
        kind,
        title: block.tool,
        messageId: message.id,
        authorUserId: run.userId,
        authorBotId: run.botId,
        mimeType: null,
        createdAt: message.createdAt,
      });
    } else {
      const artifact = artifactById.get(id);
      const page = pageById.get(id);
      const source = block.kind === "page" ? page : artifact;
      if (!source) continue;
      items.set(key, {
        id,
        kind,
        title: "title" in source ? source.title : source.name,
        messageId: message.id,
        authorUserId: source.userId,
        authorBotId: "runId" in source && !source.runId ? null : source.botId,
        mimeType: artifact?.mimeType ?? null,
        createdAt: source.createdAt.toISOString(),
        // A media tool's output keeps what made it, so the library shows it as generated.
        ...((block.kind === "image" || block.kind === "file") && block.generated
          ? { generated: block.generated }
          : {}),
      });
    }
    if (items.size === libraryLimit) break;
  }
  return [...items.values()];
}
