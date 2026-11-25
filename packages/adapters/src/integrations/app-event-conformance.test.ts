import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComposioConnector } from "../providers/integration/composio/composio-connector.js";
import { composioDeliveryParts } from "../providers/integration/composio/composio-events.js";
import { FakeComposioClient } from "../providers/integration/composio/composio-fake.js";

/**
 * What every integration provider that declares app events must do, offline against its fake.
 * A provider joins by adding a case that builds it with and without push delivery and can sign a
 * delivery for a subscription it made.
 */
type ProviderCase = {
  name: string;
  build(push: boolean): {
    provider: ManagedConnectorProvider;
    /** A connected account of `app` for `userId`, as `Connection.providerRef` stores it. */
    connect(userId: string, app: string): string;
    /** Whether the provider still holds the subscription. */
    holds(handle: string): boolean;
    /** A signed delivery for the subscription; `secret` overrides the right one. */
    deliver(
      handle: string,
      data: Record<string, unknown>,
      options?: { id?: string; timestamp?: number; secret?: string },
    ): { headers: Headers; body: Uint8Array };
  };
};

const SECRET = "whsec-test-secret";

const CASES: ProviderCase[] = [
  {
    name: "composio",
    build(push) {
      const fake = new FakeComposioClient();
      return {
        provider: new ComposioConnector({
          client: fake,
          ...(push ? { webhookSecret: SECRET } : {}),
        }),
        connect: (userId, app) => fake.connect(userId, app),
        holds: (handle) => fake.triggerInstances.has(handle),
        deliver: (handle, data, options = {}) =>
          fake.triggerDelivery(handle, data, options.secret ?? SECRET, options),
      };
    },
  },
];

function context(userId = "user-1"): AdapterContext {
  return {
    operationId: "app-event-conformance",
    traceId: "app-event-conformance",
    spaceId: "space-1",
    userId,
    signal: new AbortController().signal,
  };
}

const PARAMS: Record<string, Record<string, string>> = {
  github: { repository: "octo/hello" },
  gmail: { query: "from:alerts@example.com" },
};

describe.each(CASES)("$name app events", (entry) => {
  it("declares events with a change check for each, so any can be polled", async () => {
    const { provider } = entry.build(false);
    const types = (await provider.eventTypes?.()) ?? [];
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(type.label.trim()).not.toBe("");
      expect(type.push).toBe(false);
      const poll = type.poll?.(PARAMS[type.app] ?? {});
      expect(poll?.tool).toBeTruthy();
      expect(poll?.track.length).toBeGreaterThan(0);
    }
    // Issues, pull requests and new mail are first-class: each is one of the declared events.
    expect(types.map((type) => type.app)).toEqual(expect.arrayContaining(["github", "gmail"]));
  });

  it("pushes nothing and trusts no delivery without its delivery secret", async () => {
    const { provider, connect } = entry.build(false);
    const ref = connect("user-1", "github");
    const [type] = ((await provider.eventTypes?.()) ?? []).filter((t) => t.app === "github");
    await expect(
      provider.subscribeEvent!(
        { app: "github", event: type!.id, params: PARAMS.github!, connectionRef: ref },
        context(),
      ),
    ).rejects.toThrow();
    const pushing = entry.build(true);
    const handle = (
      await pushing.provider.subscribeEvent!(
        {
          app: "github",
          event: type!.id,
          params: PARAMS.github!,
          connectionRef: pushing.connect("user-1", "github"),
        },
        context(),
      )
    ).handle;
    expect(
      await provider.verifyEventDelivery!(pushing.deliver(handle, { title: "Bug" })),
    ).toBeNull();
  });

  it("subscribes, delivers authentic events once per delivery id, and unsubscribes", async () => {
    const { provider, connect, holds, deliver } = entry.build(true);
    const types = (await provider.eventTypes?.()) ?? [];
    for (const type of types) expect(type.push).toBe(true);
    for (const app of ["github", "gmail"]) {
      const type = types.find((candidate) => candidate.app === app)!;
      const ref = connect("user-1", app);
      const { handle } = await provider.subscribeEvent!(
        { app, event: type.id, params: PARAMS[app]!, connectionRef: ref },
        context(),
      );
      expect(holds(handle)).toBe(true);

      const first = await provider.verifyEventDelivery!(
        deliver(handle, { title: "Hello" }, { id: "d-1" }),
      );
      expect(first).toEqual({ deliveryId: "d-1", handle, payload: { title: "Hello" } });
      // A retry of the same delivery keeps its id, so it starts nothing new.
      const retry = await provider.verifyEventDelivery!(
        deliver(handle, { title: "Hello" }, { id: "d-1" }),
      );
      expect(retry?.deliveryId).toBe(first?.deliveryId);

      await provider.unsubscribeEvent!(handle, context());
      expect(holds(handle)).toBe(false);
      // Removing it again finds nothing to remove, which is success.
      await expect(provider.unsubscribeEvent!(handle, context())).resolves.toBeUndefined();
    }
  });

  it("refuses forged, altered and replayed deliveries", async () => {
    const { provider, connect, deliver } = entry.build(true);
    const [type] = ((await provider.eventTypes?.()) ?? []).filter((t) => t.app === "github");
    const { handle } = await provider.subscribeEvent!(
      {
        app: "github",
        event: type!.id,
        params: PARAMS.github!,
        connectionRef: connect("user-1", "github"),
      },
      context(),
    );
    expect(
      await provider.verifyEventDelivery!(deliver(handle, {}, { secret: "wrong" })),
    ).toBeNull();
    const signed = deliver(handle, { title: "A" });
    const altered = new TextEncoder().encode(
      new TextDecoder().decode(signed.body).replace('"A"', '"B"'),
    );
    expect(
      await provider.verifyEventDelivery!({ headers: signed.headers, body: altered }),
    ).toBeNull();
    const stale = deliver(handle, {}, { timestamp: Date.now() - 60 * 60_000 });
    expect(await provider.verifyEventDelivery!(stale)).toBeNull();
    const unsigned = new Headers(signed.headers);
    unsigned.delete("webhook-signature");
    expect(
      await provider.verifyEventDelivery!({ headers: unsigned, body: signed.body }),
    ).toBeNull();
  });

  it("subscribes the chosen account, not whichever the provider picks", async () => {
    const { provider, connect } = entry.build(true);
    const [type] = ((await provider.eventTypes?.()) ?? []).filter((t) => t.app === "github");
    await expect(
      provider.subscribeEvent!(
        {
          app: "github",
          event: type!.id,
          params: PARAMS.github!,
          connectionRef: "ca_someone_else",
        },
        context(),
      ),
    ).rejects.toThrow();
    connect("user-2", "github");
    const own = connect("user-1", "github");
    await expect(
      provider.subscribeEvent!(
        { app: "github", event: type!.id, params: PARAMS.github!, connectionRef: own },
        context(),
      ),
    ).resolves.toMatchObject({ handle: expect.any(String) });
  });
});

describe("composio delivery payload versions", () => {
  it("reads the trigger and data from each version the vendor sends", () => {
    expect(
      composioDeliveryParts({ metadata: { trigger_id: "ti_1" }, data: { title: "x" } }),
    ).toEqual({ handles: ["ti_1"], data: { title: "x" } });
    expect(
      composioDeliveryParts({
        type: "github_issue_added_event",
        data: {
          trigger_nano_id: "ti_2",
          trigger_id: "uuid-2",
          connection_id: "c",
          user_id: "u",
          title: "y",
        },
      }),
    ).toEqual({ handles: ["ti_2", "uuid-2"], data: { title: "y" } });
    expect(composioDeliveryParts({ trigger_id: "ti_3", payload: { title: "z" } })).toEqual({
      handles: ["ti_3"],
      data: { title: "z" },
    });
    expect(composioDeliveryParts({ hello: "world" })).toBeUndefined();
  });
});
