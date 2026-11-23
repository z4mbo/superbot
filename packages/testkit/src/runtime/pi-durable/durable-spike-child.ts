// Child process for the durable spike: opens a SQLite storage, starts or resumes one run, and
// reports what happens on stdout so the parent test can kill it at a chosen moment. The same
// command starts and resumes: the root conversation and the request ID find the earlier run.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SpikeChildConfig, SpikeEvent } from "./durable-spike-fixture.js";
import {
  SPIKE_EVENT_PREFIX,
  SPIKE_SETTINGS,
  spikeModels,
  spikeRegistry,
  spikeWorkdir,
  summarizeTranscript,
} from "./durable-spike-fixture.js";

function emit(event: SpikeEvent) {
  process.stdout.write(`${SPIKE_EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

async function main() {
  const config = JSON.parse(process.argv[2] ?? "") as SpikeChildConfig;
  const context = BACKGROUND_CONTEXT;
  // A line on stdin lets hanging tools return, so the parent decides when a stalled writer goes
  // on. The open stdin also keeps the process alive while a tool hangs.
  const release = new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  const storage = await openNodeSqliteStorage(config.storagePath);
  const harness = await Harness.open(
    storage,
    {
      models: spikeModels(config.endpoints),
      registry: spikeRegistry({
        workdir: spikeWorkdir(config.workdir),
        hang: config.hang,
        release,
        onEvent: emit,
      }),
      settings: SPIKE_SETTINGS,
      onReport: (report) => emit({ event: "error", message: `${report.kind}: ${report.error}` }),
    },
    context,
  );
  const root = await harness.root(context, { agent: { model: config.model } });
  // Continue whatever the last process left unfinished, before anything new is admitted.
  harness.resume();
  emit({ event: "ready" });
  const submission = await root.submit(
    { type: "input", content: config.prompt, requestId: config.requestId },
    context,
  );
  const settled = await submission.wait(context);
  const view = await root.context(context);
  emit({
    event: "settled",
    status: settled.status,
    ...(settled.status === "unanswered" ? { reason: String(settled.reason) } : {}),
    transcript: summarizeTranscript(view.messages),
  });
  await harness.close(context);
}

main()
  .catch((error: unknown) => {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
