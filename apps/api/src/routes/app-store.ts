import { listInstalledApps, readAppLaunch } from "@rakazo/adapters";
import { appCatalog, installApp, submitApp, uninstallApp } from "../app-store/app-store.js";
import type { RouterContext } from "./context.js";

export function appStoreRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    apps: {
      catalog: authed.apps.catalog.handler(({ input }) => appCatalog(deps.prisma, input.query)),
      installed: authed.apps.installed.handler(({ context }) =>
        listInstalledApps(deps.prisma, context.actor),
      ),
      submit: authed.apps.submit.handler(({ context, input }) =>
        submitApp(
          {
            prisma: deps.prisma,
            adminEmails: deps.env.adminEmails,
            webOrigin: deps.env.webOrigin,
            // The provider tracks the send, so shutdown drains it; requests do not wait on it.
            sendEmail: deps.email
              ? (message) =>
                  void message
                    .then((built) => deps.email?.send(built))
                    .catch((error) => deps.onEmailError?.(error))
              : undefined,
          },
          context.actor,
          input,
        ),
      ),
      install: authed.apps.install.handler(({ context, input }) =>
        installApp(deps.prisma, context.actor, input),
      ),
      uninstall: authed.apps.uninstall.handler(({ context, input }) =>
        uninstallApp(deps.prisma, context.actor, input.id),
      ),
      launch: authed.apps.launch.handler(async ({ context, input }) => {
        const {
          manifest: _manifest,
          source: _source,
          server: _server,
          ...launch
        } = await readAppLaunch(deps.prisma, context.actor, input.id);
        return launch;
      }),
    },
  };
}
