import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { botModelPick, modelOptionKey } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { asSystem } from "../system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type WireRequest = ModelEmulatorRequest & { reasoning_effort?: string };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

function reply(text: string, seen: WireRequest[], prompt: string) {
  return {
    expect(request: ModelEmulatorRequest) {
      seen.push(request as WireRequest);
      expect(JSON.stringify(request.messages)).toContain(prompt);
    },
    response: { type: "text" as const, text },
  };
}

describe.skipIf(!databaseAvailable)("a bot's picked model", () => {
  it("is saved by the picker's update and is the model the next run calls", async () => {
    const mainSeen: WireRequest[] = [];
    const pickedSeen: WireRequest[] = [];
    const main = await startModelEmulator({
      modelId: "fixture-main-model",
      apiKey: "fixture-main-key",
      steps: [
        reply("From the main model.", mainSeen, "First question."),
        reply("Back on the main model.", mainSeen, "Third question."),
      ],
    });
    const picked = await startModelEmulator({
      modelId: "fixture-picked-model",
      apiKey: "fixture-picked-key",
      steps: [reply("From the picked model.", pickedSeen, "Second question.")],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-bot-model-pick-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("@rakazo/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        encryptionKey: "bot-model-pick-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `bot-model-pick-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Model pick fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = <T>(procedure: string, input: unknown) =>
        rpc<T>(handles.app, cookie, procedure, input);

      // The first connection becomes the Space's main model; the second is only offered.
      await call("models/connect", {
        provider: main.model.provider,
        modelId: main.model.id,
        baseUrl: main.baseUrl,
        apiKey: "fixture-main-key",
      });
      await call("models/connect", {
        provider: picked.model.provider,
        modelId: picked.model.id,
        baseUrl: picked.baseUrl,
        apiKey: "fixture-picked-key",
        reasoning: true,
        credentialId: null,
        makeDefault: false,
      });
      const bot = await call<{ id: string }>("bots/create", {
        name: "Model pick",
        title: "",
        description: "",
        instructions: "Answer briefly.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);

      const runOnce = async (text: string) => {
        const sent = await call<{ runId: string }>("threads/send", { botId: bot.id, text });
        const run = await vi.waitFor(
          async () => {
            const row = await asSystem(handles.prisma).run.findUnique({
              where: { id: sent.runId },
              select: { status: true, modelProvider: true, modelId: true, error: true },
            });
            if (row?.status === "failed") {
              main.assertComplete();
              picked.assertComplete();
              throw new Error(`Run failed: ${row.error}`);
            }
            expect(row?.status).toBe("completed");
            return row!;
          },
          { timeout: 20_000, interval: 100 },
        );
        return { provider: run.modelProvider, id: run.modelId };
      };

      expect(await runOnce("First question.")).toEqual({
        provider: main.model.provider,
        id: "fixture-main-model",
      });

      // The pickers save a model and then, separately, its thinking level.
      await call("bots/update", {
        botId: bot.id,
        ...botModelPick(modelOptionKey(picked.model.provider, picked.model.id)),
      });
      await call("bots/update", { botId: bot.id, thinkingLevel: "high" });
      const saved = (
        await call<Array<{ id: string; modelProvider: string | null; modelId: string | null }>>(
          "bots/list",
          {},
        )
      ).find((row) => row.id === bot.id);
      expect(saved).toMatchObject({
        modelProvider: picked.model.provider,
        modelId: "fixture-picked-model",
        thinkingLevel: "high",
      });

      expect(await runOnce("Second question.")).toEqual({
        provider: picked.model.provider,
        id: "fixture-picked-model",
      });
      expect(pickedSeen.map((request) => [request.model, request.reasoning_effort])).toEqual([
        ["fixture-picked-model", "high"],
      ]);

      // Clearing the pick follows the Space's main model again.
      await call("bots/update", { botId: bot.id, ...botModelPick("") });
      expect(await runOnce("Third question.")).toEqual({
        provider: main.model.provider,
        id: "fixture-main-model",
      });
      main.assertComplete();
      picked.assertComplete();
      expect(mainSeen.map((request) => request.model)).toEqual([
        "fixture-main-model",
        "fixture-main-model",
      ]);
      // A model connected without thinking support gets no thinking level.
      expect(mainSeen.every((request) => request.reasoning_effort === undefined)).toBe(true);
    } finally {
      try {
        await stop?.();
      } finally {
        await Promise.all([main.close(), picked.close()]);
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

async function rpc<T>(app: App, cookie: string, procedure: string, input: unknown): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
