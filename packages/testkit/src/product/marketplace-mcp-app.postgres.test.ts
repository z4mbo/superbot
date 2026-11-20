import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as RemoteMcp from "@rakazo/adapters/remote-mcp";
import type { createApp } from "@rakazo/api/app";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import { MCP_APP_MIME_TYPE } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";

const fixtureNetwork = vi.hoisted(() => ({
  remote: undefined as Pick<RemoteMcp.RemoteMcpOptions, "fetch" | "resolveHostname"> | undefined,
}));

vi.mock("@rakazo/adapters/remote-mcp", async (importOriginal) => {
  const remote = await importOriginal<typeof RemoteMcp>();
  return {
    ...remote,
    listRemoteMcpTools: (options: RemoteMcp.RemoteMcpOptions) =>
      remote.listRemoteMcpTools({ ...options, ...fixtureNetwork.remote }),
    callRemoteMcpTool: (...[options, ...args]: Parameters<typeof remote.callRemoteMcpTool>) =>
      remote.callRemoteMcpTool({ ...options, ...fixtureNetwork.remote }, ...args),
  };
});

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("marketplace MCP app in chat (PostgreSQL)", () => {
  const sample = new URL(
    "../../../../examples/plugins/marketplace-unit-converter/",
    import.meta.url,
  );
  const submission: RpcInput<"pluginRegistry/submit"> = {
    slug: `marketplace-mcp-app-${randomUUID()}`,
    version: 1,
    manifest: JSON.parse(readFileSync(new URL("manifest.json", sample), "utf8")),
  };
  const email = `${submission.slug}@example.test`;
  const origin = "http://127.0.0.1:5173";
  const prompt = "Convert 100 Celsius to Fahrenheit with the marketplace converter.";
  const conversion = { value: 100, from: "celsius", to: "fahrenheit" };
  let handles: Awaited<ReturnType<typeof createApp>>;
  let sampleServer: Server;
  let dataDir: string;
  let afterToolCall: (() => Promise<unknown>) | undefined;
  const requests: Array<{ method: string; params?: { uri?: string } }> = [];

  beforeAll(async () => {
    const entry = fileURLToPath(new URL("server.ts", sample));
    const { createConverterServer }: { createConverterServer: () => Server } = await import(entry);
    sampleServer = createConverterServer();
    sampleServer.listen(0, "127.0.0.1");
    await once(sampleServer, "listening");
    const address = sampleServer.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no port");
    const resolveHostname = async () => [{ address: "93.184.215.14", family: 4 as const }];
    fixtureNetwork.remote = {
      resolveHostname,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://units.example.com/mcp");
        const request = JSON.parse(String(init?.body)) as (typeof requests)[number];
        requests.push(request);
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, init);
        if (request.method === "tools/call") await afterToolCall?.();
        return response;
      },
    };
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-marketplace-mcp-app-"));
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      webOrigin: origin,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      signupsEnabled: "true",
      adminEmails: [email],
      remoteConnectors: { resolveHostname },
    });
  });

  afterAll(async () => {
    await handles?.stop();
    if (sampleServer) {
      const closed = once(sampleServer, "close");
      sampleServer.close();
      await closed;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function signup(address: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: address, password: "password12", name: "Marketplace fixture" }),
    });
    expect(response.status).toBe(200);
    return sessionCookieHeader(response);
  }

  function raw<T extends RpcPath>(cookie: string, route: T, input: RpcInput<T>, spaceId?: string) {
    return handles.app.request(`/rpc/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }

  async function rpc<T extends RpcPath>(
    cookie: string,
    route: T,
    input: RpcInput<T>,
  ): Promise<RpcOutput<T>> {
    const response = await raw(cookie, route, input);
    const body = await response.text();
    expect(response.ok, `${route}: ${body}`).toBe(true);
    return JSON.parse(body).json;
  }

  it("reads and exposes HTML in the approved conversation only", async () => {
    const owner = await signup(email);
    const outsider = await signup(`outsider-${email}`);
    const db = asSystem(handles.prisma);
    const me = await rpc(owner, "me", {});
    await db.user.update({ where: { id: me.userId }, data: { emailVerified: true } });
    const bot = await rpc(owner, "bots/create", { name: "Temperature agent" });
    const otherBot = await rpc(owner, "bots/create", { name: "Other agent" });
    await Promise.all([
      discardBotIntroRun(handles, owner, bot.id),
      discardBotIntroRun(handles, owner, otherBot.id),
    ]);
    const { id: versionId } = await rpc(owner, "pluginRegistry/submit", submission);
    await rpc(owner, "pluginRegistry/review", { versionId, decision: "approved" });
    const { id: installationId } = await rpc(owner, "pluginRegistry/install", { versionId });
    const setGrant = (partIds: string[]) =>
      rpc(owner, "pluginRegistry/setGrants", { installationId, botId: bot.id, partIds });
    await setGrant(["temperatures"]);
    await rpc(owner, "autoReview/set", { mode: "ask" });
    const conversation = await rpc(owner, "threads/createBotConversation", { botId: bot.id });
    const otherConversation = await rpc(owner, "threads/createBotConversation", { botId: bot.id });
    const target = { botId: bot.id, threadId: conversation.threadId };
    const otherTarget = { botId: bot.id, threadId: otherConversation.threadId };
    const ungrantedTarget = { botId: otherBot.id };

    let selectedTool: string | undefined;
    const offered = vi.fn();
    const runtime = vi.spyOn(handles.runtime, "run").mockImplementation(async function* (request) {
      if (request.prompt.includes(prompt)) {
        const tool = request.tools.find(({ name }) =>
          name.startsWith("marketplace__convert_temperature"),
        );
        offered(request.botId, tool?.name);
        if (tool) selectedTool = tool.name;
        if (selectedTool) {
          yield {
            type: "tool",
            name: selectedTool,
            args: conversion,
            executionId: `${request.runId}:convert`,
          };
        }
      }
      yield { type: "done", text: "Fixture conversion finished." };
    });

    const waitForApproval = async (chat: typeof target, runId: string) => {
      const approval = await vi.waitFor(
        async () => {
          const snapshot = await rpc(owner, "threads/get", chat);
          const card = snapshot.messages.find(
            (message) =>
              message.runId === runId &&
              message.blocks.some((block) => block.kind === "ask" && block.approvalEffectId),
          );
          expect(card).toBeDefined();
          return card!;
        },
        { timeout: 15_000 },
      );
      return () =>
        rpc(owner, "threads/answer", {
          ...chat,
          runId,
          messageId: approval.id,
          answer: "allow",
        });
    };
    const waitForCompletion = (runId: string) =>
      vi.waitFor(
        async () => {
          expect(
            await db.run.findUnique({ where: { id: runId }, select: { status: true } }),
          ).toEqual({ status: "completed" });
        },
        { timeout: 15_000 },
      );

    try {
      const { runId } = await rpc(owner, "threads/send", { ...target, text: prompt });
      const approve = await waitForApproval(target, runId);
      expect(requests.map(({ method }) => method)).toContain("tools/list");
      expect(requests.map(({ method }) => method)).not.toContain("tools/call");
      expect(requests.map(({ method }) => method)).not.toContain("resources/read");
      await approve();
      await waitForCompletion(runId);
      const snapshot = await rpc(owner, "threads/get", target);
      const app = snapshot.messages
        .flatMap(({ blocks }) => blocks)
        .find((block) => block.kind === "app");
      expect(app).toMatchObject({
        server: "Unit converter",
        tool: "convert_temperature",
        toolArguments: conversion,
        toolResult: { structuredContent: { value: 212, unit: "fahrenheit" } },
      });
      expect(requests.filter(({ method }) => method === "tools/call")).toHaveLength(1);
      expect(requests.filter(({ method }) => method === "resources/read")).toEqual([
        expect.objectContaining({ params: { uri: "ui://unit-converter/temperature.html" } }),
      ]);
      const { artifactId } = app!;
      const artifact = await rpc(owner, "artifacts/get", { ...target, artifactId });
      expect(artifact.mimeType).toBe(MCP_APP_MIME_TYPE);
      expect(Buffer.from(artifact.contentBase64, "base64").toString("utf8")).toBe(
        readFileSync(new URL("temperature.html", sample), "utf8"),
      );
      expect((await rpc(owner, "artifacts/listSpace", {})).items).toEqual([]);
      expect(await rpc(owner, "conversationLibrary/list", target)).toEqual([
        expect.objectContaining({ kind: "app", title: "convert_temperature" }),
      ]);
      expect(await rpc(owner, "conversationLibrary/list", otherTarget)).toEqual([]);
      expect((await rpc(owner, "threads/get", otherTarget)).messages).toEqual([]);
      expect((await raw(owner, "artifacts/get", { ...otherTarget, artifactId })).ok).toBe(false);
      expect((await raw(owner, "artifacts/get", { botId: bot.id, artifactId })).ok).toBe(false);
      expect((await raw(owner, "artifacts/getById", { artifactId })).ok).toBe(false);
      expect((await raw(owner, "artifacts/listVersions", { familyId: artifactId })).ok).toBe(false);
      expect(
        (await raw(owner, "threads/send", { ...otherTarget, artifactIds: [artifactId] })).ok,
      ).toBe(false);
      expect((await raw(outsider, "artifacts/get", { ...target, artifactId }, me.spaceId)).ok).toBe(
        false,
      );

      requests.length = 0;
      const ungranted = await rpc(owner, "threads/send", { ...ungrantedTarget, text: prompt });
      await waitForCompletion(ungranted.runId);
      expect(offered).toHaveBeenCalledWith(otherBot.id, undefined);
      expect(requests).toEqual([]);
      expect(
        (await rpc(owner, "threads/get", ungrantedTarget)).messages.flatMap(({ blocks }) => blocks),
      ).not.toContainEqual(expect.objectContaining({ kind: "app" }));

      const revoked = await rpc(owner, "threads/send", { ...otherTarget, text: prompt });
      const approveBeforeRevocation = await waitForApproval(otherTarget, revoked.runId);
      afterToolCall = () => setGrant([]);
      await approveBeforeRevocation();
      await waitForCompletion(revoked.runId);
      expect(requests.filter(({ method }) => method === "tools/call")).toHaveLength(1);
      expect(requests.map(({ method }) => method)).not.toContain("resources/read");
      expect(
        (await rpc(owner, "threads/get", otherTarget)).messages.flatMap(({ blocks }) => blocks),
      ).not.toContainEqual(expect.objectContaining({ kind: "app" }));
    } finally {
      afterToolCall = undefined;
      runtime.mockRestore();
    }
  }, 40_000);
});
