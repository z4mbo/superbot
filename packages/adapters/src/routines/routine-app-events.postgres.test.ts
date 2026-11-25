import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ComposioConnector } from "../providers/integration/composio/composio-connector.js";
import { FakeComposioClient } from "../providers/integration/composio/composio-fake.js";
import {
  APP_EVENT_RECONNECT,
  releaseConnectionAppEvents,
  releaseRoutineAppEventsIn,
  resolveRoutineAppEvents,
  routineAppEventViews,
  saveRoutineAppEventsIn,
  settleRoutineAppEvents,
  syncRoutineAppEvents,
} from "./routine-app-events.js";

const SECRET = "app-event-test-secret";

/** Jobs as the queue keeps them: by key, the last one written wins, a cancel removes it. */
function recordingJobs() {
  const keyed = new Map<string, BackgroundJob>();
  const put = (job: BackgroundJob) => keyed.set(job.replaceKey ?? randomUUID(), job);
  const jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "enqueueManyIn" | "cancel"> = {
    enqueue: async (job) => void put(job),
    enqueueIn: async (_tx, job) => void put(job),
    enqueueManyIn: async (_tx, list) => void list.forEach(put),
    cancel: async (key) => void keyed.delete(key),
  };
  return { jobs, keyed };
}

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
describePostgres("routine app events (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `app-events-${randomUUID()}@rakazo.test`;
  let fake: FakeComposioClient;
  let provider: ManagedConnectorProvider;
  let queue: ReturnType<typeof recordingJobs>;
  let deps: Parameters<typeof syncRoutineAppEvents>[0];

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine app events fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  beforeEach(() => {
    fake = new FakeComposioClient();
    provider = new ComposioConnector({ client: fake, webhookSecret: SECRET });
    queue = recordingJobs();
    deps = { prisma: system, jobs: queue.jobs, connectors: { managed: () => provider } };
  });

  async function fixture(app = "github") {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "app event fixture",
        prompt: "triage it",
        crons: [],
        active: true,
      },
    });
    const connection = await system.connection.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        connectorId: "composio",
        provider: app,
        displayName: app === "github" ? "GitHub" : "Gmail",
        status: "connected",
        providerRef: fake.connect(identity.userId, app),
      },
    });
    return { routine, connection };
  }

  async function save(
    routine: { id: string; spaceId: string; userId: string },
    inputs: Parameters<typeof resolveRoutineAppEvents>[2],
  ) {
    const resolved = await resolveRoutineAppEvents(deps, identity, inputs);
    if ("error" in resolved) throw new Error(resolved.error);
    const releases = await system.$transaction((tx) =>
      saveRoutineAppEventsIn(tx, queue.jobs, routine, resolved.events),
    );
    await settleRoutineAppEvents(deps, routine.id, releases);
    return resolved;
  }

  const issueEvent = (connectionId: string) => ({
    app: "github",
    event: "issue_added",
    connectionId,
    params: { repository: "octo/hello" },
  });

  it("subscribes the chosen account and repository when saved, then drops the backup job", async () => {
    const { routine, connection } = await fixture();
    await save(routine, [issueEvent(connection.id)]);

    const [row] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(row).toMatchObject({ checked: false, error: null, connectorId: "composio" });
    expect(fake.triggerInstances.get(row!.handle!)).toMatchObject({
      userId: identity.userId,
      slug: "GITHUB_ISSUE_ADDED_EVENT",
      connectedAccountId: connection.providerRef,
      config: { owner: "octo", repo: "hello" },
    });
    expect([...queue.keyed.keys()]).toEqual([]);

    const views = await routineAppEventViews(deps, [routine.id]);
    expect(views.get(routine.id)).toEqual([
      expect.objectContaining({ label: "GitHub: New issue", checked: false, error: null }),
    ]);
  });

  it("keeps an unchanged event's subscription and releases a dropped one", async () => {
    const { routine, connection } = await fixture();
    await save(routine, [issueEvent(connection.id)]);
    const [before] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    await save(routine, [issueEvent(connection.id)]);
    const [kept] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(kept?.handle).toBe(before?.handle);

    await save(routine, []);
    expect(await system.routineAppEvent.count({ where: { routineId: routine.id } })).toBe(0);
    expect(fake.triggerInstances.has(before!.handle!)).toBe(false);
    expect([...queue.keyed.keys()]).toEqual([]);
  });

  it("releases while paused and subscribes again on resume", async () => {
    const { routine, connection } = await fixture();
    await save(routine, [issueEvent(connection.id)]);
    const [first] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });

    await system.routine.update({ where: { id: routine.id }, data: { active: false } });
    await syncRoutineAppEvents(deps, routine.id);
    const [paused] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(paused?.handle).toBeNull();
    expect(fake.triggerInstances.size).toBe(0);

    await system.routine.update({ where: { id: routine.id }, data: { active: true } });
    await syncRoutineAppEvents(deps, routine.id);
    const [resumed] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(resumed?.handle).toBeTruthy();
    expect(resumed?.handle).not.toBe(first?.handle);
  });

  it("releases a deleted routine's subscriptions by the jobs its delete committed", async () => {
    const { routine, connection } = await fixture();
    await save(routine, [issueEvent(connection.id)]);
    const releases = await system.$transaction(async (tx) => {
      const releases = await releaseRoutineAppEventsIn(tx, queue.jobs, routine);
      await tx.routine.delete({ where: { id: routine.id } });
      return releases;
    });
    expect(queue.keyed.size).toBe(1);
    await settleRoutineAppEvents(deps, null, releases);
    expect(fake.triggerInstances.size).toBe(0);
    expect(queue.keyed.size).toBe(0);
  });

  it("stops an event whose connection was removed and says to reconnect", async () => {
    const { routine, connection } = await fixture();
    await save(routine, [issueEvent(connection.id)]);
    await system.connection.update({ where: { id: connection.id }, data: { status: "revoked" } });
    await releaseConnectionAppEvents(deps, connection);
    const [row] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(row).toMatchObject({ handle: null, error: APP_EVENT_RECONNECT });
    expect(fake.triggerInstances.size).toBe(0);
    // A sync does not subscribe a connection that is gone.
    await syncRoutineAppEvents(deps, routine.id);
    expect(fake.triggerInstances.size).toBe(0);
  });

  it("keeps the provider's refusal for the owner instead of retrying it", async () => {
    const { routine, connection } = await fixture();
    fake.failTriggerCreate = "Repository not found";
    await save(routine, [issueEvent(connection.id)]);
    const [row] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(row?.handle).toBeNull();
    expect(row?.error).toContain("Repository not found");
    expect(queue.keyed.size).toBe(0);
  });

  it("makes a lapsing subscription again before it lapses, on the queue's schedule", async () => {
    const { routine, connection } = await fixture();
    let made = 0;
    const released: string[] = [];
    const types = (await provider.eventTypes?.()) ?? [];
    const renewAt = () => new Date(Date.now() + 60 * 60_000);
    deps = {
      ...deps,
      connectors: {
        managed: () => ({
          ...provider,
          eventTypes: async () => types,
          subscribeEvent: async () => ({ handle: `lapsing-${++made}`, renewAt: renewAt() }),
          unsubscribeEvent: async (handle: string) => void released.push(handle),
        }),
      },
    };
    await save(routine, [issueEvent(connection.id)]);
    const due = queue.keyed.get(`routine.app-events:${routine.id}`)?.availableAt?.getTime() ?? 0;
    expect(due).toBeLessThan(renewAt().getTime());
    expect(due).toBeGreaterThan(Date.now());

    // The job fires once the renewal is due.
    await system.routineAppEvent.updateMany({
      where: { routineId: routine.id },
      data: { renewAt: new Date(Date.now() + 60_000) },
    });
    await syncRoutineAppEvents(deps, routine.id);
    const [row] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(row?.handle).toBe("lapsing-2");
    expect(released).toEqual(["lapsing-1"]);
  });

  it("checks for changes with the provider's read tool when it does not push the event", async () => {
    provider = new ComposioConnector({ client: fake });
    const { routine, connection } = await fixture("gmail");
    const resolved = await save(routine, [
      { app: "gmail", event: "new_message", connectionId: connection.id, params: {} },
    ]);
    expect(resolved.watch).toMatchObject({
      kind: "tool",
      tool: "GMAIL_FETCH_EMAILS",
      everyMinutes: 5,
    });
    const [row] = await system.routineAppEvent.findMany({ where: { routineId: routine.id } });
    expect(row).toMatchObject({ checked: true, handle: null });
    expect(fake.triggerInstances.size).toBe(0);
    // Only one event can be checked for changes.
    expect(
      await resolveRoutineAppEvents(deps, identity, [
        { app: "gmail", event: "new_message", connectionId: connection.id, params: {} },
        { app: "gmail", event: "new_message", connectionId: connection.id, params: { query: "x" } },
      ]),
    ).toEqual({ error: "Only one app event can be checked for changes per routine." });
  });

  it("refuses an event from someone else's or a missing connection, or with bad settings", async () => {
    const { connection } = await fixture();
    const other = { ...identity, userId: randomUUID() };
    expect(await resolveRoutineAppEvents(deps, other, [issueEvent(connection.id)])).toEqual({
      error: "Connect the app first, then add its event.",
    });
    expect(
      await resolveRoutineAppEvents(deps, identity, [
        { ...issueEvent(connection.id), params: { repository: "not a repo" } },
      ]),
    ).toEqual({ error: "Enter the repository as owner/name." });
    expect(
      await resolveRoutineAppEvents(deps, identity, [{ ...issueEvent(connection.id), params: {} }]),
    ).toEqual({ error: "Enter repository for New issue." });
    expect(
      await resolveRoutineAppEvents(deps, identity, [
        { ...issueEvent(connection.id), event: "star_added" },
      ]),
    ).toEqual({ error: "GitHub has no such event." });
  });
});
