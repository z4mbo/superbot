import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemberMainModel, selectConfiguredModel } from "../../models/model-roles.js";
import { mainRole, withModelRoles } from "../../models/model-roles.test-support.js";
import { serializeModelSecret } from "../../models/model-secret.js";
import type { ModelChoice } from "../../models/model-selection.js";
import {
  findConnectedModelCredential,
  inboundRoutineModelPin,
  routineRunModelPin,
  runModelChoice,
} from "../../models/model-selection.js";
import { CHATGPT_OAUTH_PROVIDER } from "../../runtime/pi/models/pi-oauth.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolvedModelRunFields, resolveRunModel } from "./run-model.js";
import { runModelBackups, startRunModel } from "./run-model-start.js";

/**
 * What a model picker saves (a bot's model and thinking level, the Space's main model, a
 * routine's model) decides the model a run asks its runtime for. These cases pin that mapping
 * onto `AgentRunRequest["model"]`, which is all a runtime receives, so a new runtime can rely on it.
 */

const scope = { userId: "user-1", spaceId: "space-1" };
const at = new Date("2026-01-01T00:00:00.000Z");

type Connection = {
  provider: string;
  /** The connection's own model; it becomes the provider's preference. */
  modelId: string;
  plaintext: string;
  thinkingLevel?: string | null;
};

function fixture(options: {
  connections?: Connection[];
  main?: { provider: string; modelId: string; thinkingLevel?: string | null } | null;
  bot?: ModelChoice | null;
  settings?: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  scripted?: boolean;
  deps?: Partial<ExecutorDeps>;
}) {
  const connections = options.connections ?? [];
  const credentials = connections.map((connection) => ({
    id: `connection-${connection.provider}`,
    userId: scope.userId,
    provider: connection.provider,
    label: connection.provider,
    secretId: `secret-${connection.provider}`,
    createdAt: at,
    updatedAt: at,
  }));
  const preferences = connections.map((connection, index) => ({
    id: `preference-${connection.provider}`,
    userId: scope.userId,
    credentialId: credentials[index]!.id,
    modelId: connection.modelId,
    thinkingLevel: connection.thinkingLevel ?? null,
    isDefault: false,
    createdAt: at,
    updatedAt: at,
    credential: credentials[index]!,
  }));
  const secrets = new Map(
    connections.map((connection, index) => [credentials[index]!.secretId, connection.plaintext]),
  );
  const prisma = withModelRoles(
    {
      bot: { findFirst: vi.fn(async () => options.bot ?? null) },
      userModelPreference: { findMany: vi.fn(async () => preferences) },
      userModelCredential: {
        findMany: vi.fn(async () => credentials),
        findFirst: vi.fn(async () => null),
      },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          secrets.has(where.id) ? { id: where.id, ciphertext: secrets.get(where.id)! } : null,
        ),
      },
      deploymentSettings: { findUnique: vi.fn(async () => options.settings ?? null) },
    },
    options.main
      ? [
          mainRole(
            scope,
            options.main.provider,
            options.main.modelId,
            options.main.thinkingLevel ?? null,
          ),
        ]
      : [],
  ) as unknown as PrismaClient;
  return {
    prisma,
    secretStore: { load: vi.fn(async (ciphertext: string) => ciphertext), put: vi.fn() },
    billingEnabled: false,
    runtime: {
      describe: () => ({ capabilities: { scripted: options.scripted === true } }),
      run: vi.fn(),
    },
    ...options.deps,
  } as unknown as ExecutorDeps;
}

const botProvider: Connection = {
  provider: "fixture-bot-provider",
  modelId: "fixture-bot-model",
  plaintext: "fixture-bot-key",
};
const mainProvider: Connection = {
  provider: "fixture-main-provider",
  modelId: "fixture-main-model",
  plaintext: "fixture-main-key",
};
const routineProvider: Connection = {
  provider: "fixture-routine-provider",
  modelId: "fixture-routine-model",
  plaintext: "fixture-routine-key",
};
const spaceMain = { provider: mainProvider.provider, modelId: mainProvider.modelId };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the model a run asks its runtime for", () => {
  it("runs the bot's picked model on that provider's connection, with the bot's thinking level", async () => {
    const deps = fixture({
      connections: [botProvider, mainProvider],
      main: spaceMain,
      bot: {
        modelProvider: botProvider.provider,
        modelId: botProvider.modelId,
        thinkingLevel: "high",
      },
    });

    const model = await resolveRunModel(deps, { ...scope, botId: "bot-1" });

    expect(model).toMatchObject({
      provider: botProvider.provider,
      id: botProvider.modelId,
      thinkingLevel: "high",
      apiKey: "fixture-bot-key",
      connectionId: "connection-fixture-bot-provider",
      billing: "api_key",
    });
    expect(model.oauth).toBeUndefined();
  });

  it("follows the Space's main model and its thinking level when the bot picked none", async () => {
    const deps = fixture({
      connections: [botProvider, mainProvider],
      main: { ...spaceMain, thinkingLevel: "low" },
      bot: { modelProvider: null, modelId: null, thinkingLevel: null },
    });

    expect(await resolveRunModel(deps, { ...scope, botId: "bot-1" })).toMatchObject({
      provider: mainProvider.provider,
      id: mainProvider.modelId,
      thinkingLevel: "low",
      apiKey: "fixture-main-key",
    });
  });

  it("applies the bot's own thinking level to the Space's main model", async () => {
    const deps = fixture({
      connections: [mainProvider],
      main: { ...spaceMain, thinkingLevel: "low" },
      bot: { modelProvider: null, modelId: null, thinkingLevel: "xhigh" },
    });

    expect(await resolveRunModel(deps, { ...scope, botId: "bot-1" })).toMatchObject({
      provider: mainProvider.provider,
      id: mainProvider.modelId,
      thinkingLevel: "xhigh",
    });
  });

  it("falls back to the Space's main model, without the bot's level, when the bot's provider is not connected", async () => {
    const deps = fixture({
      connections: [mainProvider],
      main: spaceMain,
      bot: {
        modelProvider: botProvider.provider,
        modelId: botProvider.modelId,
        thinkingLevel: "high",
      },
    });

    expect(await resolveRunModel(deps, { ...scope, botId: "bot-1" })).toMatchObject({
      provider: mainProvider.provider,
      id: mainProvider.modelId,
      thinkingLevel: null,
      apiKey: "fixture-main-key",
    });
  });

  it("falls back to the deployment's model, on the deployment's key, when the main model's connection is gone", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const deps = fixture({
      connections: [],
      main: spaceMain,
      settings: { defaultModelProvider: "openrouter", defaultModelId: "fixture/deployment-model" },
      deps: { deploymentModelKey: "fixture-deployment-key" },
    });

    const model = await resolveRunModel(deps, scope);

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "fixture/deployment-model",
      thinkingLevel: null,
      apiKey: "fixture-deployment-key",
      billing: "deployment",
    });
    expect(model.connectionId).toBeUndefined();
  });

  it("asks for a model connection when nothing can run", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const deps = fixture({ connections: [], main: spaceMain });

    await expect(resolveRunModel(deps, scope)).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
  });

  it("uses a scripted runtime's own model when nothing is configured", async () => {
    const deps = fixture({ connections: [], scripted: true });

    expect(await resolveRunModel(deps, scope)).toMatchObject({
      provider: "scripted",
      id: "scripted",
      thinkingLevel: null,
    });
  });

  it("hands a subscription sign-in over as OAuth, never as an API key", async () => {
    const expires = Date.now() + 60 * 60 * 1000;
    const subscription: Connection = {
      // A provider that signs in with a subscription; the model id is a fixture.
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "fixture-subscription-model",
      plaintext: serializeModelSecret({
        kind: "oauth",
        credential: {
          type: "oauth",
          access: "fixture-access-token",
          refresh: "fixture-refresh-token",
          expires,
        },
      }),
    };
    const deps = fixture({
      connections: [subscription],
      main: { provider: subscription.provider, modelId: subscription.modelId },
    });

    const model = await resolveRunModel(deps, scope);

    expect(model).toMatchObject({
      provider: subscription.provider,
      id: subscription.modelId,
      apiKey: undefined,
      billing: "subscription",
      oauth: {
        credential: expect.objectContaining({ access: "fixture-access-token", expires }),
      },
    });
    expect(model.oauth?.persist).toBeTypeOf("function");
    expect(model.oauth?.refresh).toBeTypeOf("function");
    expect(model.oauth?.retire).toBeTypeOf("function");
  });

  it("carries a compatible server's address, protocol, headers and key", async () => {
    const compatible: Connection = {
      provider: "openai-compatible",
      modelId: "fixture-compatible-model",
      plaintext: serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiProtocol: "responses",
        headers: { "x-fixture-session": "fixture-session-value" },
        apiKey: "fixture-compatible-key",
        reasoning: true,
      }),
    };
    const deps = fixture({
      connections: [compatible],
      main: { provider: compatible.provider, modelId: compatible.modelId, thinkingLevel: "high" },
      deps: { mcpAllowPrivateEndpoint: true },
    });

    expect(await resolveRunModel(deps, scope)).toMatchObject({
      provider: "openai-compatible",
      id: "fixture-compatible-model",
      thinkingLevel: "high",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "responses",
      headers: { "x-fixture-session": "fixture-session-value" },
      apiKey: "fixture-compatible-key",
      allowPrivateEndpoint: true,
      reasoning: true,
      billing: "custom_endpoint",
    });
  });
});

/**
 * A chat run picks its model as the run assembly does: the run's own pin (a routine's model, or
 * the model of messages that waited for a busy run) before the bot's pick, then the Space's main
 * model, then the first backup that starts.
 */
async function chatRunModel(
  deps: ExecutorDeps,
  run: ModelChoice & { id: string; modelPinned: boolean },
  bot: ModelChoice,
): Promise<AgentRunRequest["model"] | undefined> {
  const choice = runModelChoice(run, bot);
  const overrideCredential =
    choice.modelProvider && choice.modelId
      ? await findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          scope,
          choice.modelProvider,
          choice.modelId,
        )
      : null;
  const selected = selectConfiguredModel({
    override: choice,
    overrideCredential,
    main: await resolveMemberMainModel(deps, scope),
    defaults: { settings: null, deployment: null },
  });
  const backups = runModelBackups(
    deps,
    { ...run, ...scope },
    { settings: null, deployment: null },
    false,
    () => undefined,
  );
  const started = await startRunModel(deps, scope, selected, undefined, backups, () => undefined);
  if (!started.start) return undefined;
  return {
    provider: started.start.provider,
    id: started.start.id,
    ...(started.start.credential ? { connectionId: started.start.credential.id } : {}),
    ...resolvedModelRunFields(started.start.resolved),
    thinkingLevel: started.start.thinkingLevel ?? null,
  };
}

describe("the model a chat run starts on", () => {
  const bot: ModelChoice = {
    modelProvider: botProvider.provider,
    modelId: botProvider.modelId,
    thinkingLevel: "high",
  };
  const routine: ModelChoice = {
    modelProvider: routineProvider.provider,
    modelId: routineProvider.modelId,
    thinkingLevel: "low",
  };
  const connections = [botProvider, mainProvider, routineProvider];

  it("runs a routine's own model and level, not the bot's", async () => {
    const pin = routineRunModelPin(routine);
    const deps = fixture({ connections, main: spaceMain });

    const model = await chatRunModel(
      deps,
      {
        id: "run-1",
        modelProvider: pin.modelProvider ?? null,
        modelId: pin.modelId ?? null,
        thinkingLevel: pin.thinkingLevel ?? null,
        modelPinned: pin.modelPinned === true,
      },
      bot,
    );

    expect(model).toMatchObject({
      provider: routineProvider.provider,
      id: routineProvider.modelId,
      thinkingLevel: "low",
      apiKey: "fixture-routine-key",
    });
  });

  it("runs the model pinned on deliveries that waited for a busy run", async () => {
    // A delivery steering into a busy run keeps its pin; the continuation run inherits it.
    const pin = inboundRoutineModelPin([routine]);
    const deps = fixture({ connections, main: spaceMain });

    expect(
      await chatRunModel(
        deps,
        {
          id: "run-2",
          modelProvider: pin.modelProvider ?? null,
          modelId: pin.modelId ?? null,
          thinkingLevel: pin.thinkingLevel ?? null,
          modelPinned: true,
        },
        bot,
      ),
    ).toMatchObject({
      provider: routineProvider.provider,
      id: routineProvider.modelId,
      thinkingLevel: "low",
    });
  });

  it("leaves a run on the bot's model when its deliveries pinned different models", () => {
    expect(
      inboundRoutineModelPin([
        routine,
        { ...routine, modelId: "fixture-other-routine-model", thinkingLevel: null },
      ]),
    ).toEqual({});
  });

  it("follows the bot's current pick when an unpinned run recorded another model", async () => {
    const deps = fixture({ connections, main: spaceMain });

    expect(
      await chatRunModel(
        deps,
        {
          id: "run-3",
          // An earlier attempt recorded the model it ran on.
          modelProvider: routineProvider.provider,
          modelId: routineProvider.modelId,
          thinkingLevel: null,
          modelPinned: false,
        },
        bot,
      ),
    ).toMatchObject({
      provider: botProvider.provider,
      id: botProvider.modelId,
      thinkingLevel: "high",
      apiKey: "fixture-bot-key",
    });
  });
});
