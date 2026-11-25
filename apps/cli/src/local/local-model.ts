import { discoverEngine } from "./engines/discovery.js";
import { EngineError } from "./engines/engine.js";
import { EngineSession, supportsPrivatePrompt } from "./engines/session.js";
import { InstalledCli, isDriverProvider } from "./installed-cli/installed-cli.js";
import { LocalModelError } from "./local-model-error.js";
import type { InstalledModel, LocalModelStore } from "./local-model-store.js";

/** A chat turn, or a private prompt about one record app that nothing else may see. */
export type PromptScope = "chat" | "appRecords";

/** Runs a prompt on a model selected on this device and returns its reply. */
export interface LocalModelDrivers {
  run(
    store: LocalModelStore,
    model: InstalledModel,
    prompt: string,
    scope: PromptScope,
  ): Promise<string>;
}

/** Record app help needs a driver that can run a prompt with nothing else in its context. */
export function supportsAppAssistance(model: InstalledModel): boolean {
  return isDriverProvider(model.provider) || supportsPrivatePrompt(model.provider);
}

/** The installed CLIs and local engines on this device. */
export const installedModels: LocalModelDrivers = {
  async run(store, model, prompt, scope) {
    if (isDriverProvider(model.provider)) return new InstalledCli(store).reply(model, prompt);
    if (scope === "appRecords" && !supportsPrivatePrompt(model.provider)) {
      throw new LocalModelError("The selected local engine doesn't support private app prompts.");
    }
    try {
      const engine = await discoverEngine(model.provider);
      if (!engine) throw new LocalModelError("The selected local CLI is missing.");
      const session =
        scope === "chat"
          ? await EngineSession.connect(engine)
          : await EngineSession.connectPrivatePrompt(engine);
      let reply: string;
      try {
        reply = (await session.prompt(model.id, prompt)).text;
      } finally {
        await session.close();
      }
      if (reply.trim() === "") throw new LocalModelError("The local CLI didn't return a reply.");
      return reply;
    } catch (error) {
      if (error instanceof EngineError) throw new LocalModelError(error.message);
      throw error;
    }
  },
};
