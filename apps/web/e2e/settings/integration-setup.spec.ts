import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

test("direct services in the Store load their bundled logos without a managed catalog", async ({
  page,
}, testInfo) => {
  await signup(page, `source-art-${Date.now()}@example.test`, "password12", "Store visitor");
  const bot = await rpc<{ id: string }>(page, "bots/create", { name: "Store guide" });
  const presets = await rpc<{ name: string; logo: string }[]>(
    page,
    "capabilities/sourcePresets",
    {},
  );
  expect(presets.length).toBeGreaterThan(0);
  await page.route("**/rpc/connections/catalog", (route) => route.fulfill({ json: { json: [] } }));
  // The link from before Integrations became Connections still opens it.
  await page.goto(`/app/${bot.id}?integrations`);
  await expect(page.getByTestId("store-connections")).toHaveAttribute("aria-selected", "true");
  const rows = page.getByTestId("source-presets");
  for (const { name, logo } of presets) {
    expect(logo).toMatch(/^\/service-logos\//);
    const icon = rows.getByRole("button", { name, exact: true }).locator("img");
    await expect(icon).toHaveAttribute("src", logo);
    await icon.scrollIntoViewIfNeeded();
    await expect
      .poll(() => icon.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
  }
  await rows.getByRole("button").first().scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "store-app-logos");
});

test("ordinary accounts can add personal MCP connections without server setup", async ({
  page,
}, testInfo) => {
  await signup(page, `personal-mcp-${Date.now()}@rakazo.test`, "password12", "Personal MCP");
  await completeOnboarding(page);
  await page.goto("/integrations/setup");
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search connections", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "notion.example.test",
              name: "Notion",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "notion",
                  source: "https://mcp.notion.example.test/mcp",
                  auth: { type: "oauth", headerName: null, note: null },
                },
              ],
            },
            {
              domain: "keyed.example.test",
              name: "Keyed tool",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "keyed",
                  source: "https://mcp.keyed.example.test/mcp",
                  auth: { type: "header", headerName: "x-api-key", note: null },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const message = "The sign-in address does not match this server's configuration.";
  await page.route("**/rpc/mcp/servers/connect", (route) =>
    route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "MCP_OAUTH_REDIRECT_MISMATCH", status: 400, message } },
    }),
  );
  await page.getByRole("textbox", { name: "Search connections", exact: true }).fill("Notion");
  await page.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await expect(page.getByText("Keyed tool", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(message);
  await expect(page.getByRole("link", { name: "Troubleshoot", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "personal-mcp-callback-mismatch");
  await page.unroute("**/rpc/mcp/servers/connect");
  await page.route("**/rpc/mcp/servers/connect", (route) =>
    route.fulfill({
      json: { json: { server: { id: "notion" }, signIn: { status: "already_connected" } } },
    }),
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "personal-mcp-without-server-admin");
});
