import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import manifest from "./manifest.json" with { type: "json" };
import { withT3 } from "./mcp.mjs";
import { pages } from "./superbot.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function saveOnce(directory, file, value) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, file);
  const temp = join(directory, `${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  try {
    try {
      await link(temp, path);
      return value;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return JSON.parse(await readFile(path, "utf8"));
    }
  } finally {
    await rm(temp);
  }
}

export async function* installations(api) {
  for await (const page of pages((input) => api.rpc("pluginRegistry/installations", input), {})) {
    yield* page.filter(
      ({ plugin }) => plugin.status === "approved" && isDeepStrictEqual(plugin.manifest, manifest),
    );
  }
}

export function readRecords(api, installationId, partId, first = {}) {
  return pages((input) => api.rpc("pluginRegistry/appRecords", input), {
    ...first,
    installationId,
    partId,
  });
}

export function addRequest(api, installationId, values) {
  return api.rpc("pluginRegistry/addAppRecord", {
    installationId,
    partId: "requests",
    operationId: randomUUID(),
    values,
  });
}

async function findRequest(api, installationId, id) {
  for await (const page of readRecords(api, installationId, "requests", { limit: 50 })) {
    const request = page.find((request) => request.id === id);
    if (request) return request;
  }
  throw new Error("Request ID was not found in this account's installation.");
}

function receiptFrom(result, recordId, projectId) {
  const { threadId, runId, status, link, projectId: launchedProject } = result;
  const href = URL.canParse(link) ? new URL(link) : null;
  if (
    launchedProject !== projectId ||
    !threadId ||
    !runId ||
    !status ||
    !href ||
    href.protocol !== "https:" ||
    href.username ||
    href.password ||
    href.search ||
    href.hash ||
    !href.pathname.startsWith("/threads/")
  ) {
    throw new Error("T3 returned an unexpected launch receipt. Inspect T3 before retrying.");
  }
  return {
    "request-id": recordId,
    "thread-id": threadId,
    "run-id": runId,
    "thread-link": link,
    status,
  };
}

export async function dispatch({
  api,
  installationId,
  recordId,
  projectId,
  server,
  space,
  directory,
  loadAuth,
}) {
  const request = await findRequest(api, installationId, recordId);
  const { title, brief } = request.values;
  if (typeof title !== "string" || !title.trim() || typeof brief !== "string" || !brief.trim()) {
    throw new Error("Request requires a title and coding brief.");
  }

  const key = digest([server, space, installationId, recordId]);
  const planFile = `${key}.dispatch.json`;
  const receiptFile = `${key}.receipt.json`;
  const intent = { projectId, request: digest([title, brief]) };
  const read = async (file) => {
    try {
      return JSON.parse(await readFile(join(directory, file), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const assertIntent = (plan) => {
    if (!isDeepStrictEqual(plan.intent, intent)) {
      throw new Error(
        "This request already has a different dispatch intent. Review the original dispatch.",
      );
    }
  };

  let plan = await read(planFile);
  if (plan) assertIntent(plan);
  let receipt = await read(receiptFile);
  if (!receipt) {
    const auth = await loadAuth();
    const connection = { url: auth.url, grant: digest(auth.token) };
    plan = await saveOnce(directory, planFile, { intent, connection, operationId: randomUUID() });
    assertIntent(plan);
    if (!isDeepStrictEqual(plan.connection, connection)) {
      throw new Error(
        "An earlier attempt used another T3 endpoint or OAuth grant. Reconcile it in T3 before taking further action.",
      );
    }
    const result = await withT3(auth, (call) =>
      call("t3_thread_launch", {
        projectId,
        title,
        message: brief,
        runtimeMode: "approval-required",
        interactionMode: "default",
        clientRequestId: plan.operationId,
      }),
    );
    receipt = await saveOnce(directory, receiptFile, receiptFrom(result, recordId, projectId));
  }
  try {
    const saved = await api.rpc("pluginRegistry/addAppRecord", {
      installationId,
      partId: "dispatches",
      operationId: plan.operationId,
      values: receipt,
    });
    return { receipt, savedToInbox: isDeepStrictEqual(saved.values, receipt) };
  } catch {
    return { receipt, savedToInbox: false };
  }
}
