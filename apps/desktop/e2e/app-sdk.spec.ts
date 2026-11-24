import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { pageViewerDocument } from "@rakazo/core";
import type { AppState } from "@rakazo/plugin-sdk";
import { applyAppAction } from "@rakazo/plugin-sdk";
import { checkAppFolder } from "@rakazo/plugin-sdk/node";
import { buildAppRuntime } from "@rakazo/plugin-sdk/runtime-build";
import { shownWindow } from "./shown-window.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const EXAMPLE = path.join(ROOT, "examples", "team-dashboard");
const SHELL = path.join(ROOT, "apps", "web", "public", "html-viewer.html");

/**
 * The desktop window hosts the web app, whose page viewer is the shell below: a sandboxed frame
 * holding a sandboxed frame. This host stands in for the web app's page view (no server or
 * database), so the window runs the real shell, runtime and example app, and actions run
 * through the SDK's own action engine, as the server runs them.
 */
const HOST = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rakazo app</title>
  <style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0;display:block}</style></head>
  <body>
    <iframe id="viewer" title="Team dashboard" src="/html-viewer.html" sandbox="allow-scripts"></iframe>
    <script>
      const viewer = document.getElementById("viewer");
      const post = (message) => viewer.contentWindow.postMessage(message, "*");
      let used = null;
      viewer.addEventListener("load", async () => post(await (await fetch("/document")).text()));
      addEventListener("message", async (event) => {
        if (event.source !== viewer.contentWindow || !event.data) return;
        const data = event.data;
        if (data.type === "rakazo-app:ready") {
          post({ type: "rakazo-app:state", ...(await (await fetch("/state")).json()) });
        } else if (data.type === "rakazo-app:action") {
          if (typeof data.gesture !== "string" || data.gesture === used) {
            post({ type: "rakazo-app:result", id: data.id, ok: false, error: "No click" });
            return;
          }
          used = data.gesture;
          const run = await (await fetch("/action", { method: "POST", body: JSON.stringify({ name: data.name, input: data.input }) })).json();
          if (run.ok) post({ type: "rakazo-app:state", state: run.state, revision: run.revision });
          post({ type: "rakazo-app:result", id: data.id, ok: run.ok, error: run.error });
        }
      });
    </script>
  </body>
</html>`;

let server: Server;
let userData: string;
let app: ElectronApplication | undefined;

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

test.beforeAll(async () => {
  const checked = await checkAppFolder(EXAMPLE);
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  const { manifest } = checked;
  let state: AppState = manifest.initialState;
  let revision = 0;
  const document = pageViewerDocument({
    runtime: await buildAppRuntime(),
    code: checked.code,
    theme: "light",
    errorTitle: "This page couldn't be shown.",
    appState: { state, revision },
    appActions: true,
  });
  const shell = await readFile(SHELL, "utf8");
  let ids = 0;
  server = createServer(async (request, response) => {
    const send = (type: string, text: string) => {
      response.writeHead(200, { "content-type": type });
      response.end(text);
    };
    if (request.url === "/api/monitoring/config") return send("application/json", '{"dsn":null}');
    if (request.url === "/html-viewer.html") return send("text/html; charset=utf-8", shell);
    if (request.url === "/document") return send("text/plain; charset=utf-8", document);
    if (request.url === "/state")
      return send("application/json", JSON.stringify({ state, revision }));
    if (request.url === "/action" && request.method === "POST") {
      const { name, input } = JSON.parse(await body(request));
      const outcome = applyAppAction(manifest, state, name, input, { newId: () => `n${++ids}` });
      if (outcome.ok) {
        state = outcome.state;
        revision += 1;
      }
      return send(
        "application/json",
        JSON.stringify(outcome.ok ? { ok: true, state, revision } : outcome),
      );
    }
    send("text/html; charset=utf-8", HOST);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-desktop-app-"));
});

test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    await rm(userData, { recursive: true, force: true });
  }
});

test("opens the example app in the desktop window and runs its actions", async () => {
  test.setTimeout(90_000);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no port");
  app = await electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      RAKAZO_PERFORMANCE_USER_DATA: userData,
      RAKAZO_WEB_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  const window = await shownWindow(app);
  const frame = window
    .locator('iframe[title="Team dashboard"]')
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
  await expect(frame.getByText("Draft the launch notes")).toBeVisible({ timeout: 30_000 });
  const screenshots = path.join(import.meta.dirname, "screenshots");
  await window.screenshot({ path: path.join(screenshots, "app-sdk-opened.png") });

  await frame.getByRole("textbox", { name: "Task" }).fill("Ship the desktop build");
  await frame.getByRole("button", { name: "Add task" }).click();
  await expect(frame.getByText("Ship the desktop build")).toBeVisible();
  await frame.getByRole("button", { name: "At risk" }).click();
  await expect(frame.locator(".rk-status").filter({ hasText: "At risk" }).first()).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, "app-sdk-actions.png") });
});
