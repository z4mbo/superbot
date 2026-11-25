import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acpCatalog } from "./catalog.js";
import { discoverEngine, knownEngine } from "./discovery.js";
import type { Engine } from "./engine.js";
import { EngineError } from "./engine.js";
import { parseModels } from "./grok.js";
import { literalPrompt } from "./restricted.js";
import { EngineSession } from "./session.js";

const SCRIPT = fileURLToPath(new URL("./engine-fixture.test-support.mjs", import.meta.url));

function fixture(id: string, mode: string): Engine {
  const engine = knownEngine(id, process.execPath, [SCRIPT, mode]);
  if (!engine) throw new Error(`Unknown engine ${id}`);
  return engine;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineError) return error.kind;
    throw error;
  }
  throw new Error("Expected the engine to refuse");
}

const sessions: EngineSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function connect(engine: Engine): Promise<EngineSession> {
  const session = await EngineSession.connect(engine);
  sessions.push(session);
  return session;
}

describe("local engines", { timeout: 90_000 }, () => {
  it("runs a profiled ACP session, refusing permissions, other methods and model changes", async () => {
    const session = await connect(fixture("grok", "grok-acp"));
    expect(session.models.map((model) => model.id)).toEqual(["one", "two"]);
    expect(session.models[0]).toEqual({ id: "one", label: "Actual model", provider: "Group" });
    expect(session.currentModel).toBe("one");
    expect(await failure(session.prompt("two", "prompt"))).toBe("unsafe");
    const again = await connect(fixture("grok", "grok-acp"));
    expect(await again.prompt("one", "prompt")).toEqual({
      text: "ACP reply",
      stopReason: "end_turn",
    });
  });

  it("refuses an engine with integrations, and engines without a prompt-only mode", async () => {
    expect(await failure(EngineSession.connect(fixture("grok", "grok-mcp")))).toBe("unsafe");
    expect(await failure(EngineSession.connect(fixture("cline", "signed-out")))).toBe("unsafe");
    expect(await failure(EngineSession.connect(fixture("cursor", "grok-headless")))).toBe("unsafe");
  });

  it("runs Grok's headless release with its own model IDs and a scoped prompt file", async () => {
    const engine = fixture("grok", "grok-headless");
    const session = await connect(engine);
    expect(session.models[1]?.id).toBe("fixture-b");
    expect((await session.prompt("fixture-b", "--always-approve is prompt text")).text).toBe(
      "headless reply",
    );
    expect(session.currentModel).toBe("fixture-b");
    const privatePrompt = await EngineSession.connectPrivatePrompt(engine);
    sessions.push(privatePrompt);
    expect(await failure(EngineSession.connectPrivatePrompt(fixture("grok", "grok-acp")))).toBe(
      "unsafe",
    );
  });

  it("lists, selects and streams Pi models over its JSON RPC", async () => {
    const session = await connect(fixture("pi", "pi"));
    expect(session.currentModel).toBe("test/one");
    expect(session.models[1]?.id).toBe("test/two");
    expect((await session.prompt("test/two", "prompt")).text).toBe("Pi reply");
  });

  const restricted: Array<[string, string, string, string]> = [
    ["gemini", "gemini", "/auth", "Gemini reply"],
    ["githubCopilot", "copilot", "--allow-all-tools", "Copilot reply"],
  ];
  if (process.platform === "linux" || process.platform === "win32") {
    restricted.push(["opencodeGo", "opencode", "/auth", "OpenCode reply"]);
  }

  it.each(restricted)(
    "runs %s on its checked release with the selected model",
    async (id, mode, prompt, expected) => {
      const session = await connect(fixture(id, mode));
      expect(await failure(session.prompt("missing", prompt))).toBe("unknownModel");
      expect(await session.prompt("two", prompt)).toMatchObject({ text: expected });
      expect(session.currentModel).toBe("two");
      if (mode !== "copilot") {
        expect(await failure(session.prompt(undefined, "unexpected tool"))).toBe("unsafe");
        expect(await failure(session.prompt(undefined, prompt))).toBe("closed");
      }
      expect(await failure(EngineSession.connect(fixture(id, "custom")))).toBe("unsafe");
    },
  );

  it("reads model catalogs and marks command-like prompts as the person's message", () => {
    expect(
      acpCatalog({
        models: {
          currentModelId: "b",
          availableModels: [{ modelId: "a", name: "A" }, { modelId: "b" }, { modelId: "a" }],
        },
      }),
    ).toEqual({
      current: "b",
      models: [
        { id: "a", label: "A" },
        { id: "b", label: "b" },
      ],
    });
    expect(
      parseModels("You are not authenticated.\nAvailable models:\n  * one (default)\n  - -bad\n"),
    ).toEqual({ models: [{ id: "one", label: "one" }], current: undefined, needsAuth: true });
    expect(() => parseModels("nothing")).toThrow(EngineError);
    expect(literalPrompt("  /auth")).toBe("User message:\n  /auth");
    expect(literalPrompt("$HOME")).toBe("User message:\n$HOME");
    expect(literalPrompt("hello /there")).toBe("hello /there");
  });

  it.skipIf(process.platform === "win32")(
    "discovers only known engines installed as executables on PATH",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "superbot-engines-"));
      directories.push(directory);
      const program = path.join(directory, "grok");
      await writeFile(program, "");
      expect(await discoverEngine("grok", [directory])).toBeUndefined();
      await chmod(program, 0o700);
      expect(await discoverEngine("grok", [directory])).toMatchObject({
        id: "grok",
        protocol: "acp",
      });
      expect(await discoverEngine(program, [directory])).toBeUndefined();
      for (const id of ["claude", "codex", "openai", "custom-acp", "museCode"]) {
        expect(await discoverEngine(id, [directory])).toBeUndefined();
      }
    },
  );
});
