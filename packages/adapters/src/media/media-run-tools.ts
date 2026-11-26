import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import { isBackgroundRunTrigger } from "@rakazo/core";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import type { MediaToolName } from "./media-generation.tool-definition.js";
import {
  availableMediaCapabilities,
  describeMediaChoices,
  listMediaProviders,
} from "./media-router.js";

/**
 * Which media tools a run offers, from what the run's user connected (or the server's own
 * provider for a kind they connected nothing for), and the choices each tool's description names.
 */
export async function runMediaToolOptions(
  deps: Pick<ExecutorDeps, "prisma" | "secretStore" | "artifacts" | "mediaProviders">,
  run: { userId: string; spaceId: string; trigger: string },
  serverDefault: MediaGenerationProvider | undefined,
) {
  // Media goes to the chat, so a run without storage, or one in the background, offers none.
  if (!deps.artifacts || isBackgroundRunTrigger(run.trigger)) return {};
  const availability = await listMediaProviders(
    {
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      serverDefault,
      registry: deps.mediaProviders,
    },
    run,
  );
  const enabled = availableMediaCapabilities(availability);
  const mediaChoices: Partial<Record<MediaToolName, string>> = {
    generate_image: describeMediaChoices(availability, "image"),
    edit_image: describeMediaChoices(availability, "image_edit"),
    generate_video: describeMediaChoices(availability, "video"),
  };
  return {
    mediaImagesEnabled: enabled.image,
    mediaImageEditEnabled: enabled.imageEdit,
    mediaVideoEnabled: enabled.video,
    mediaChoices,
  };
}
