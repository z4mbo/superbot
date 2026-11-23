import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { pageViewerDocument, withSandboxedArtifactCsp } from "@rakazo/core";
import { pageViewerCode } from "../../../packages/page-kit/src/compile.js";
import { buildPageRuntime } from "../../../packages/page-kit/src/runtime-build.js";
import { shownWindow } from "./shown-window.js";

// An installed app's code, as the store serves it to the viewer once a launch is checked.
const APP_SOURCE = `export default function FocusTimer() {
  const [sessions, setSessions] = useState(0);
  return (
    <Page title="Focus timer">
      <Metrics metrics={[{ value: String(sessions), label: "Sessions today" }]} />
      <button onClick={() => setSessions(sessions + 1)}>Start a session</button>
    </Page>
  );
}
`;

let server: Server;
let userData: string;
let app: ElectronApplication | undefined;

// The desktop window shows the web app, which runs an app in the page viewer's sandbox: a frame
// with scripts but no same-origin access and a policy that loads nothing from the network.
test.beforeAll(async () => {
  const runtime = await buildPageRuntime();
  const viewer = withSandboxedArtifactCsp(
    pageViewerDocument({
      runtime,
      code: pageViewerCode(APP_SOURCE),
      theme: "light",
      errorTitle: "This app couldn't be shown.",
    }),
  );
  const host = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App sandbox</title>
<style>body{margin:0;font:14px system-ui}iframe{border:0;width:100vw;height:100vh}</style></head>
<body><iframe id="app" title="Focus timer" sandbox="allow-scripts"></iframe>
<script>document.getElementById("app").srcdoc = ${JSON.stringify(viewer).replace(/</g, "\\u003c")};</script>
</body></html>`;
  server = createServer((request, response) => {
    if (request.url === "/api/monitoring/config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ dsn: null }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(host);
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

test("runs an installed app's code isolated in the page sandbox", async () => {
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
  const page = await shownWindow(app);
  const frame = page.frameLocator("#app");
  await expect(frame.getByText("Sessions today", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await frame.getByRole("button", { name: "Start a session", exact: true }).click();
  await expect(frame.getByText("1", { exact: true })).toBeVisible();

  // The app's code cannot reach the window that hosts it, nor load anything from the network.
  const reach = await page
    .frames()
    .find((candidate) => candidate !== page.mainFrame())!
    .evaluate(async () => {
      let parentRead = "blocked";
      try {
        parentRead = window.parent.document.title;
      } catch {}
      const fetched = await fetch("https://example.com/").then(
        () => "loaded",
        () => "blocked",
      );
      return { parentRead, fetched, origin: window.origin };
    });
  expect(reach).toEqual({ parentRead: "blocked", fetched: "blocked", origin: "null" });

  const shots = path.join(import.meta.dirname, "screenshots");
  await mkdir(shots, { recursive: true });
  // The cross-platform workflow uploads this per OS.
  await page.screenshot({ path: path.join(shots, "app-sandbox.png") });
});
