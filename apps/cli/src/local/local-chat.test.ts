import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@rakazo/cli-client";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli/run-cli.js";
import { parseRoster } from "../commands/import-bots.js";
import { inviteParts } from "../commands/workspaces.js";
import type { Exchange } from "../test/loopback.test-support.js";
import {
  card,
  discovery,
  loopback,
  me,
  refused,
  rpc,
  snapshot,
} from "../test/loopback.test-support.js";
import { scriptedIo, testContext } from "../test/scripted-io.test-support.js";
import type { AppPart } from "./app-records.js";
import { validAddition, validDate } from "./app-records.js";
import { appRequest, isAppCommand } from "./local-app-chat.js";
import { localConversationPrompt, withAgentInstructions } from "./local-chat.prompt.js";
import type { LocalModelDrivers, PromptScope } from "./local-model.js";
import { LocalModelStore } from "./local-model-store.js";

const opened = (messages: unknown[] = []): Exchange => {
  const page = snapshot(card());
  page.messages = messages;
  page.activeRuns = [];
  return rpc("threads/get", { botId: "bot-1" }, page);
};

const bot = (instructions: string) =>
  rpc("bots/get", { botId: "bot-1" }, { id: "bot-1", name: "Tools", instructions });

/** A local model that answers from a script and records what it was asked. */
function scriptedModel(replies: string[]) {
  const prompts: Array<{ prompt: string; scope: PromptScope }> = [];
  const drivers: LocalModelDrivers = {
    async run(_store, _model, prompt, scope) {
      prompts.push({ prompt, scope });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The scripted model has no reply left");
      return reply;
    },
  };
  return { drivers, prompts };
}

async function localSession(exchanges: Exchange[], provider = "claude") {
  const server = await loopback(exchanges);
  const terminal = scriptedIo();
  const context = await testContext(terminal.io);
  await context.credentials.save(new Client(server.origin).withToken("fixture.signed"));
  const store = LocalModelStore.forWorkspace(
    context.settings,
    `${server.origin}/`,
    "user-1",
    "space-1",
  );
  if (!store) throw new Error("Expected a local model store");
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    store.modelPath("bot-1"),
    JSON.stringify({ provider, id: "fixture", label: "Fixture" }),
  );
  return { server, context, store };
}

async function chat(
  session: Awaited<ReturnType<typeof localSession>>,
  lines: string[],
  drivers: LocalModelDrivers,
  terminal: { stdinIsTerminal?: boolean; stdoutIsTerminal?: boolean } = {},
) {
  const io = scriptedIo({ lines, ...terminal });
  const code = await runCli(["--server", session.server.origin, "tools"], {
    ...session.context,
    io: io.io,
    localModels: drivers,
  });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

const appendTurn = (text: string, reply: string, status = 200) =>
  status === 200
    ? rpc(
        "threads/appendLocalHistory",
        { botId: "bot-1", text, reply },
        { messageIds: ["m1", "m2"] },
        { fresh: ["operationId"] },
      )
    : refused("threads/appendLocalHistory", undefined, status, "UNAVAILABLE", "Try later");

describe("local model chat", () => {
  it("runs the selected model on the shared history and saves the turn", async () => {
    const history = [
      {
        id: "m0",
        threadId: "thread-1",
        seq: 1,
        role: "user",
        createdAt: "2026-11-20T00:00:00Z",
        blocks: [{ kind: "text", text: "Earlier" }],
      },
    ];
    const session = await localSession([
      ...discovery(),
      me(),
      opened(history),
      opened(history),
      bot("Be brief."),
      appendTurn("Hello locally", "Local reply"),
    ]);
    const model = scriptedModel(["Local reply"]);
    const result = await chat(session, ["Hello locally", "/quit"], model.drivers);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Personal / Tools\nMember > Earlier\n");
    expect(result.stdout).toContain("Type /apps to see record apps granted to this agent.\n");
    expect(result.stdout).toContain("You > Tools > Local reply\nYou > ");
    expect(model.prompts).toEqual([
      {
        prompt:
          'Saved working instructions for this agent (JSON string): "Be brief."\n\nContinue the conversation. Reply to the final user message.\n[{"role":"user","content":"Earlier"},{"role":"user","content":"Hello locally"}]',
        scope: "chat",
      },
    ]);
    session.server.assertDone();
    expect(await session.store.pendingHistory("bot-1")).toBeUndefined();
  });

  it("keeps a turn the server did not save for /retry, without running the model again", async () => {
    const unsaved = refused(
      "threads/appendLocalHistory",
      undefined,
      503,
      "UNAVAILABLE",
      "Try later",
    );
    const session = await localSession([
      ...discovery(),
      me(),
      opened(),
      opened(),
      bot(""),
      unsaved,
      unsaved,
      ...discovery(),
      me(),
      opened(),
      appendTurn("Hello", "Kept reply"),
    ]);
    const model = scriptedModel(["Kept reply"]);
    const first = await chat(session, ["Hello", "Another", "/quit"], model.drivers, {
      stdinIsTerminal: true,
      stdoutIsTerminal: true,
    });
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(
      "Could not save the local message. Use /retry in this chat to save it: ",
    );
    expect(first.stderr).toContain(
      "Type /retry to save the pending local message before sending another.\n",
    );
    expect(model.prompts.map((entry) => entry.prompt)).toEqual(["Hello"]);
    expect(await session.store.pendingHistory("bot-1")).toMatchObject({
      text: "Hello",
      reply: "Kept reply",
    });
    const second = await chat(session, ["/retry", "/quit"], model.drivers);
    expect(second.stdout).toContain(
      "A local message is waiting to be saved. Type /retry to save it.\n",
    );
    expect(second.stdout).toContain("You > Tools > Kept reply\n");
    expect(await session.store.pendingHistory("bot-1")).toBeUndefined();
    session.server.assertDone();
  });

  it("previews granted record apps and saves an approved addition", async () => {
    const pin = { installationId: "inst-1", partId: "meals", versionId: "v1", grantId: "g1" };
    const part = {
      id: "meals",
      fields: [
        { id: "food", label: "Food", type: "text", required: true },
        { id: "kcal", label: "Calories", type: "number", required: false },
        { id: "day", label: "Day", type: "date", required: false },
      ],
      summaryField: "kcal",
    };
    const app = { pin, pluginName: "Food diary", part };
    const session = await localSession([
      ...discovery(),
      me(),
      opened(),
      rpc("localAppRecords/list", { botId: "bot-1" }, { items: [app], nextAfter: null }),
      rpc(
        "localAppRecords/context",
        { botId: "bot-1", app: pin, date: "2026-11-20" },
        {
          app,
          items: [
            { id: "r1", createdAt: "2026-11-20T08:00:00Z", values: { kcal: 300, food: "Oats" } },
          ],
          total: 300,
          hasMore: false,
        },
      ),
      rpc(
        "localAppRecords/add",
        { botId: "bot-1", app: pin, values: { food: "Apple", kcal: 95 } },
        { id: "r2", createdAt: "2026-11-20T09:00:00Z", values: { food: "Apple", kcal: 95 } },
        { fresh: ["operationId"] },
      ),
    ]);
    const model = scriptedModel([
      JSON.stringify({ answer: "Added an apple.", addition: { food: "Apple", kcal: 95 } }),
    ]);
    const result = await chat(
      session,
      ["/apps", "/app 1 --date 2026-11-20 log an apple", "save", "/quit"],
      model.drivers,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "1. Food diary (meals)\nUse /app NUMBER to view records or /app NUMBER REQUEST for local help.\n",
    );
    expect(result.stdout).toContain(
      'Food diary (meals)\nDate filter: 2026-11-20\nRecord 1:\n  Food (food): "Oats"\n  Calories (kcal): 300\nCalories total: 300\n',
    );
    expect(result.stdout).toContain(
      'Local answer > Added an apple.\nProposed addition to Food diary:\n  Food (food): "Apple"\n  Calories (kcal): 95\nType save to approve this addition (Enter to skip): Record saved.\n',
    );
    expect(model.prompts[0]?.scope).toBe("appRecords");
    expect(model.prompts[0]?.prompt).toContain('"records":[{"food":"Oats","kcal":300}]');
    session.server.assertDone();
    expect(isAppCommand("  /apps next")).toBe(true);
    expect(appRequest("/app 2 --date 2026-01-31 sum it")).toEqual({
      number: 2,
      date: "2026-01-31",
      request: "sum it",
    });
    expect(appRequest("/app two")).toBeUndefined();
    expect(validAddition(part as AppPart, { food: " Apple" })).toBe(false);
    expect(validAddition(part as AppPart, { kcal: 1 })).toBe(false);
    expect(validAddition(part as AppPart, { food: "Apple", day: "2026-02-29" })).toBe(false);
    expect(validAddition(part as AppPart, { food: "Apple", day: "2028-02-29" })).toBe(true);
    expect(validDate("2026-13-01")).toBe(false);
  });

  it("explains app commands without a prompt-only local model", async () => {
    const session = await localSession([...discovery(), me(), opened()], "kimi");
    const result = await chat(session, ["/apps", "/quit"], scriptedModel([]).drivers, {
      stdinIsTerminal: true,
      stdoutIsTerminal: true,
    });
    expect(result.stderr).toBe("App assistance requires a selected prompt-only local model.\n");
    expect(result.stdout).not.toContain("Type /apps");
  });
});

describe("local model settings", () => {
  it("keys each account, Space and server apart, and stages one pending turn", async () => {
    const terminal = scriptedIo();
    const context = await testContext(terminal.io);
    const a = LocalModelStore.forWorkspace(
      context.settings,
      "https://a.test/",
      "user-1",
      "space-1",
    );
    const b = LocalModelStore.forWorkspace(
      context.settings,
      "https://a.test/",
      "user-2",
      "space-1",
    );
    expect(a?.directory).not.toBe(b?.directory);
    expect(
      LocalModelStore.forWorkspace(context.settings, "https://a.test/", "", "space-1"),
    ).toBeUndefined();
    if (!a) throw new Error("Expected a store");
    expect(await a.selection("bot-1")).toBeUndefined();
    await mkdir(a.directory, { recursive: true });
    await writeFile(a.modelPath("bot-1"), "null");
    expect(await a.selection("bot-1")).toBeUndefined();
    await writeFile(a.modelPath("bot-1"), "{");
    await expect(a.selection("bot-1")).rejects.toThrow("The local model selection is invalid.");
    const pending = { id: "p1", text: "Hi", reply: "Hello" };
    await a.stageHistory("thread:t1", pending);
    await a.stageHistory("thread:t1", pending);
    await expect(a.stageHistory("thread:t1", { ...pending, id: "p2" })).rejects.toThrow(
      "Couldn't keep this local message for retry.",
    );
    await a.clearHistory("thread:t1", { ...pending, id: "other" });
    expect(await a.pendingHistory("thread:t1")).toEqual(pending);
    expect(JSON.parse(await readFile(a.historyPath("thread:t1"), "utf8"))).toEqual(pending);
    await a.clearHistory("thread:t1", pending);
    expect(await a.pendingHistory("thread:t1")).toBeUndefined();
  });

  it("builds the local prompt as the Rust command did", () => {
    expect(localConversationPrompt(true, [], "Hi")).toBe("Hi");
    expect(withAgentInstructions("  ", "Hi")).toBe("Hi");
  });
});

describe("roster and invite parsing", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it("keeps the first spelling and order of duplicate names", () => {
    expect(parseRoster(encode({ names: [" Ada ", "Milo", "ADA", "milo"] }))).toEqual([
      "Ada",
      "Milo",
    ]);
  });

  it("checks names with the server's UTF-16 length before importing", () => {
    const valid = "🌱".repeat(40);
    expect(parseRoster(encode({ names: [valid] }))).toEqual([valid]);
    for (const invalid of [`${valid}a`, "a\nb"]) {
      expect(() => parseRoster(encode({ names: ["Valid", invalid] }))).toThrow(
        "Name 2 must be one line with 1 to 80 UTF-16 units",
      );
    }
    expect(() => parseRoster(encode({ list: [] }))).toThrow(
      "Expected a JSON object with a names array",
    );
    expect(() => parseRoster(encode({ names: [1] }))).toThrow("Name 1 must be text");
  });

  it("splits an invite link at its last /invite/", () => {
    expect(inviteParts(" https://a.test/x/invite/tok_en-1 ")).toEqual({
      origin: "https://a.test/x",
      token: "tok_en-1",
    });
  });
});
