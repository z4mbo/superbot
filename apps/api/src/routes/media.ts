import {
  connectMediaProvider,
  disconnectMediaProvider,
  mediaCatalog,
  setMediaPreference,
} from "../media/media-settings.js";
import type { RouterContext } from "./context.js";

/** Image and video providers the signed-in person connects for their own account. */
export function mediaRoutes({ authed, deps }: RouterContext) {
  return {
    media: {
      catalog: authed.media.catalog.handler(({ context }) => mediaCatalog(deps, context.actor)),
      connect: authed.media.connect.handler(({ context, input }) =>
        connectMediaProvider(deps, context.actor, input, context.signal),
      ),
      disconnect: authed.media.disconnect.handler(({ context, input }) =>
        disconnectMediaProvider(deps, context.actor, input),
      ),
      setPreference: authed.media.setPreference.handler(({ context, input }) =>
        setMediaPreference(deps, context.actor, input),
      ),
    },
  };
}
