import { CommandError } from "../output/errors.js";
import type { CliContext } from "../session/context.js";
import { line } from "../terminal/io.js";
import { installMethod, updateCommand } from "./install-method.js";
import {
  CHECK_TIMEOUT_MS,
  latestRelease,
  readCache,
  recordCheck,
  registryUrl,
  resolved,
} from "./update-check.js";
import { isNewer, PACKAGE_NAME } from "./version.js";

/**
 * `superbot update`: asks the registry now and prints the command that updates this install. It
 * does not run it: a global install may need permissions the person grants themselves.
 */
export async function updateCheckCommand(context: CliContext, json: boolean): Promise<void> {
  const { env, scriptPath, version } = resolved(context);
  const result = await latestRelease(context, CHECK_TIMEOUT_MS);
  if (result.kind === "unpublished") {
    throw new CommandError(`${PACKAGE_NAME} is not on the npm registry yet`);
  }
  if (result.kind === "unreachable") {
    throw new CommandError(`Could not check for updates: ${registryUrl(env).host} did not answer`);
  }
  await recordCheck(context, result, await readCache(context));
  const latest = result.version;
  const available = isNewer(latest, version);
  const method = installMethod(scriptPath);
  const command = updateCommand(method) ?? `npm install -g ${PACKAGE_NAME}@latest`;
  if (json) {
    line(
      context.io,
      JSON.stringify({
        current: version,
        latest,
        updateAvailable: available,
        ...(available ? { command } : {}),
      }),
    );
    return;
  }
  if (!available) {
    line(context.io, `${PACKAGE_NAME} ${version} is up to date.`);
    return;
  }
  line(context.io, `${PACKAGE_NAME} ${latest} is available (you have ${version}).`);
  if (method === "source") {
    line(context.io, "This copy was built from source: pull and rebuild it, or install it with:");
    line(context.io, `  ${command}`);
    return;
  }
  line(context.io, `Update with: ${command}`);
}
