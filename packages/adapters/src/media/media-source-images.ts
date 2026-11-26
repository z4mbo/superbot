import type { AdapterContext, ArtifactStore, MediaInputImage } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { detectImageMimeType } from "./image-mime-type.js";
import type { MediaImageLoader } from "./media-generation-input.js";
import { MediaInputError } from "./media-generation-input.js";

/** Artifact ids are generated, never paths: no slash, dot or space. */
const ARTIFACT_ID = /^[a-z0-9]{16,40}$/i;
const INPUT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Reads the images a media call names, only from what this run may see: an image attached to
 * the message it answers, an artifact of this user's chat with this bot (or this group), or a
 * file in the bot's workspace.
 */
export function mediaImageLoader(deps: {
  prisma: Pick<PrismaClient, "artifact" | "message">;
  artifacts: Pick<ArtifactStore, "get">;
  run: { spaceId: string; userId: string; botId: string; sourceMessageId: string | null };
  /** The conversation the run answers in, which an attached image must come from. */
  threadId: string;
  groupId?: string;
  context: AdapterContext;
  /** Reads a workspace file, or undefined when the run has no workspace. */
  readWorkspaceFile?: (path: string, maxBytes: number) => Promise<Uint8Array>;
}): MediaImageLoader {
  const { run } = deps;
  const scope = {
    spaceId: run.spaceId,
    userId: run.userId,
    ...(deps.groupId ? { groupId: deps.groupId } : { botId: run.botId, groupId: null }),
  };
  const unavailable = (field: string, reference: string) =>
    new MediaInputError(`${field}: "${reference}" is not an image in this conversation.`);

  async function artifactBytes(id: string, field: string, reference: string) {
    const row = await deps.prisma.artifact.findFirst({
      where: { id, ...scope },
      select: { storageKey: true, mimeType: true, size: true },
    });
    if (!row || !INPUT_MIME_TYPES.has(row.mimeType)) throw unavailable(field, reference);
    if (row.size > ATTACHMENT_MAX_BYTES)
      throw new MediaInputError(`${field}: "${reference}" is too large.`);
    return deps.artifacts.get(row.storageKey, deps.context);
  }

  async function attachedImage(field: string) {
    const source = run.sourceMessageId
      ? await deps.prisma.message.findUnique({
          where: { id: run.sourceMessageId },
          select: { id: true, blocks: true, threadId: true },
        })
      : null;
    const image =
      source?.threadId === deps.threadId
        ? storedMessageBlocks(source)
            .filter((block) => block.kind === "image")
            .at(-1)
        : undefined;
    if (image?.kind !== "image")
      throw new MediaInputError(`${field}: the message has no attached image.`);
    return artifactBytes(image.artifactId, field, "attached");
  }

  return async (reference, field) => {
    let bytes: Uint8Array;
    if (reference === "attached") bytes = await attachedImage(field);
    else if (ARTIFACT_ID.test(reference)) bytes = await artifactBytes(reference, field, reference);
    else if (deps.readWorkspaceFile) {
      try {
        bytes = await deps.readWorkspaceFile(reference, ATTACHMENT_MAX_BYTES);
      } catch (error) {
        deps.context.signal.throwIfAborted();
        if (error instanceof MediaInputError) throw error;
        throw new MediaInputError(`${field}: could not read "${reference}" from the workspace.`);
      }
    } else throw unavailable(field, reference);
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES)
      throw new MediaInputError(`${field}: "${reference}" is too large.`);
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType || !INPUT_MIME_TYPES.has(mimeType))
      throw new MediaInputError(`${field}: "${reference}" is not a PNG, JPEG or WebP image.`);
    return { bytes, mimeType } as MediaInputImage;
  };
}
