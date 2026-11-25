import { readFileSync } from "node:fs";
import type { MinimumClientBuilds } from "@rakazo/contracts";
import {
  CLIENT_BUILD_HEADER,
  CLIENT_UPDATE_REQUIRED,
  CLIENT_UPDATE_REQUIRED_STATUS,
  clientUpdateRequired,
  isBuildId,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import type { MiddlewareHandler } from "hono";

/**
 * The web build ships in the same image as the API, so reading its id from its assets keeps one
 * source of truth. Dev servers and images without a web build have none; the handshake stays quiet.
 */
export function readDeployedWebBuild(
  file: URL = new URL("../../web/dist/build-id", import.meta.url),
): string | undefined {
  try {
    const build = readFileSync(file, "utf8").trim();
    return isBuildId(build) ? build : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names the deployed web build on every reply and refuses clients older than their minimum.
 * A page served from another origin (the hosted web app) is a different build entirely, so it is
 * never told about this one; only a configured minimum can refuse it.
 */
export function clientBuildMiddleware(options: {
  webBuild: string | undefined;
  minimums: MinimumClientBuilds;
  servedElsewhere?: (origin: string) => boolean;
}): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const webBuild = origin && options.servedElsewhere?.(origin) ? undefined : options.webBuild;
    if (clientUpdateRequired(c.req.header(CLIENT_BUILD_HEADER), options.minimums)) {
      // The oRPC error shape, so web and mobile clients read it like any other RPC failure.
      return c.json(
        {
          json: {
            defined: false,
            code: CLIENT_UPDATE_REQUIRED,
            status: CLIENT_UPDATE_REQUIRED_STATUS,
            message: "Update required",
          },
        },
        CLIENT_UPDATE_REQUIRED_STATUS,
        {
          "cache-control": "no-store",
          ...(webBuild ? { [SERVER_BUILD_HEADER]: webBuild } : {}),
        },
      );
    }
    await next();
    if (webBuild) c.header(SERVER_BUILD_HEADER, webBuild);
  };
}
