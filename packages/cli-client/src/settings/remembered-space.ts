import {
  parseStringMap,
  readOptionalFile,
  stringifyStringMap,
  writeFileAtomic,
} from "./atomic-file.js";
import type { SettingsEnvironment } from "./settings-directory.js";
import { missingSettingsDirectory, settingsFile } from "./settings-directory.js";

type HasServer = { readonly server: string };

/** The Space this person last had open on this server, which the apps open on again. */
export async function rememberedSpace(
  client: HasServer,
  userId: string,
  settings: SettingsEnvironment = {},
): Promise<string | undefined> {
  const file = settingsFile("spaces.json", settings);
  if (!file) return undefined;
  return (await readSpaces(file)).get(spaceKey(client, userId));
}

export async function rememberSpace(
  client: HasServer,
  userId: string,
  spaceId: string,
  settings: SettingsEnvironment = {},
): Promise<void> {
  const file = settingsFile("spaces.json", settings);
  if (!file) throw missingSettingsDirectory();
  const spaces = await readSpaces(file);
  spaces.set(spaceKey(client, userId), spaceId);
  await writeFileAtomic(file, stringifyStringMap(spaces));
}

function spaceKey(client: HasServer, userId: string): string {
  return `${client.server} ${userId}`;
}

/** The saved choices; an unreadable file only forgets them. */
async function readSpaces(file: string): Promise<Map<string, string>> {
  try {
    const text = await readOptionalFile(file);
    return text === undefined ? new Map() : parseStringMap(text);
  } catch {
    return new Map();
  }
}
