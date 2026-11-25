import type { SystemCredentialStore } from "@rakazo/cli-client";
import { Client, CredentialStore, selectedServer } from "@rakazo/cli-client";
import { readManifestFile } from "../manifest/manifest-file.js";
import { authError, registryRequest, selectSpace } from "../registry/registry-request.js";
import { scaffold } from "../scaffold/scaffold.js";
import { parseCommandLine } from "./arguments.js";
import { CommandError, errorText } from "./errors.js";
import { escapeForTerminal } from "./escape.js";

/** Where a run reads its settings and writes its output; tests pass their own. */
export type Environment = {
  env: Record<string, string | undefined>;
  cwd: string;
  platform?: NodeJS.Platform;
  /** The system credential store; defaults to this computer's. */
  systemStore?: SystemCredentialStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Runs one command line and resolves its exit status. */
export async function run(argv: string[], environment: Environment): Promise<number> {
  const parsed = parseCommandLine(argv, environment.env);
  if ("code" in parsed) {
    if (parsed.stdout) environment.stdout(parsed.stdout);
    if (parsed.stderr) environment.stderr(parsed.stderr);
    return parsed.code;
  }
  try {
    await execute(parsed, environment);
    return 0;
  } catch (error) {
    environment.stderr(`Error: ${escapeForTerminal(errorText(error))}\n`);
    return 1;
  }
}

async function execute(
  { command, server, space }: Exclude<ReturnType<typeof parseCommandLine>, { code: number }>,
  environment: Environment,
): Promise<void> {
  const { cwd } = environment;
  if (command.kind === "init") {
    const created = await scaffold(
      command.manifest,
      command.slug,
      command.name,
      command.template,
      cwd,
    );
    for (const file of created) environment.stdout(`Created ${file}\n`);
    return;
  }
  if (command.kind === "validate") {
    await readManifestFile(command.manifest, cwd);
    environment.stdout("Manifest is valid\n");
    return;
  }
  const request = await registryRequest(command, cwd);
  const settings = { env: environment.env, platform: environment.platform };
  const client = new Client(await selectedServer(server, settings));
  const signedIn = await new CredentialStore({
    systemStore: environment.systemStore,
    settings,
  }).load(client);
  if (!signedIn) {
    throw new CommandError(
      "No saved session for this server. Run superbot login for the same server",
    );
  }
  let spaces: Awaited<ReturnType<Client["listSpaces"]>>;
  try {
    spaces = await signedIn.listSpaces();
  } catch (error) {
    throw authError(error);
  }
  const result = await request(signedIn, selectSpace(spaces, space).id);
  environment.stdout(`${JSON.stringify(result, null, 2)}\n`);
}
