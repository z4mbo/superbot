import { expect, test } from "@playwright/test";
import type { ProviderUsage } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

type BotRow = { id: string; name: string; modelProvider: string | null; modelId: string | null };

const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();
const readAt = new Date().toISOString();

// Provider usage is read with real sign-ins and keys, which e2e never has.
const roster: ProviderUsage[] = [
  {
    credentialId: "cred-claude",
    provider: "anthropic",
    name: "Claude",
    label: "Claude",
    kind: "subscription",
    plan: "Max",
    status: "ok",
    windows: [
      { period: "session", usedPercent: 38, resetsAt: hours(2.5) },
      { period: "week", usedPercent: 64, resetsAt: hours(80) },
      { period: "week", usedPercent: 52, resetsAt: hours(80), model: "Opus" },
    ],
    credits: null,
    readAt,
  },
  {
    // The connection the chat's models run on below.
    credentialId: "cred-e2e",
    provider: "openai",
    name: "ChatGPT",
    label: "ChatGPT",
    kind: "subscription",
    plan: "Plus",
    status: "ok",
    windows: [
      { period: "session", usedPercent: 86, resetsAt: hours(0.6) },
      { period: "week", usedPercent: 41, resetsAt: hours(130) },
    ],
    credits: null,
    readAt,
  },
  {
    credentialId: "cred-router",
    provider: "openrouter",
    name: "OpenRouter",
    label: "OpenRouter",
    kind: "api_key",
    plan: null,
    status: "ok",
    windows: [],
    credits: { usedUsd: 4.2, limitUsd: null, remainingUsd: null, period: null, resetsAt: null },
    readAt,
  },
  {
    credentialId: "cred-xai",
    provider: "xai",
    name: "xAI",
    label: "xAI",
    kind: "api_key",
    plan: null,
    status: "unavailable",
    windows: [],
    credits: null,
    readAt: null,
  },
  {
    credentialId: "cred-gemini",
    provider: "google",
    name: "Gemini",
    label: "Gemini",
    kind: "subscription",
    plan: null,
    status: "not_signed_in",
    windows: [],
    credits: null,
    readAt: null,
  },
];

test("the sidebar shows every connection's usage, and the model list leads to it", async ({
  page,
}, testInfo) => {
  const refreshes: unknown[] = [];
  await page.route("**/rpc/usage/providers", (route) => {
    const body = route.request().postDataJSON() as { json?: { refresh?: boolean } } | null;
    if (body?.json?.refresh) refreshes.push(body.json);
    return route.fulfill({ json: { json: roster } });
  });
  const stamp = Date.now();
  await signup(page, `sidebar-usage-${stamp}@rakazo.test`, "password12", "Sidebar usage");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = new URL(page.url()).pathname.split("/").at(-1)!;
  const bot = (await rpc<BotRow[]>(page, "bots/list", {})).find((row) => row.id === botId)!;
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "cred-e2e",
            provider: "openai",
            label: "OpenAI",
            hasKey: true,
            isDefault: true,
            enabledModelIds: ["e2e-fast", "e2e-smart"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/bots/update", async (route) => {
    const sent = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    await route.fulfill({
      json: { json: { ...bot, modelProvider: sent.modelProvider, modelId: sent.modelId } },
    });
  });
  await page.goto(`/app/${botId}`);

  // One line per connection, the one with the least room first.
  const section = page.getByTestId("sidebar-usage");
  const rows = section.getByTestId("usage-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("ChatGPT");
  await expect(rows.nth(0)).toContainText("86%");
  await expect(rows.nth(1)).toContainText("Claude");
  await expect(rows.nth(1)).toContainText("64%");
  await expect(rows.nth(2)).toContainText("$4.20 used");
  await expect(rows.nth(3)).toContainText("Usage not available");
  await expect(rows.nth(4)).toContainText("Not signed in");
  await captureScreenshot(page, testInfo, "sidebar-usage-compact");

  await section.getByRole("button", { name: "Refresh usage" }).click();
  await expect.poll(() => refreshes.length).toBe(1);

  const header = section.getByRole("button", { name: "Usage", exact: true });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(section.getByRole("progressbar", { name: "Weekly Opus" })).toHaveAttribute(
    "aria-valuenow",
    "52",
  );
  await expect(rows.nth(0)).toContainText("Plus");
  await expect(rows.nth(0)).toContainText("Resets in");
  await captureScreenshot(page, testInfo, "sidebar-usage-expanded");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");

  // The chat runs on the ChatGPT connection once a model of it is picked.
  const picker = page.getByTestId("chat-capsule").getByRole("button", { name: /^Model/ });
  await picker.click();
  await page.getByRole("option", { name: "e2e-smart" }).click();
  await expect(picker).toContainText("e2e-smart");
  await picker.click();
  const usage = page.getByRole("option", { name: /^Usage/ });
  await expect(usage).toContainText("86% used");
  await captureScreenshot(page, testInfo, "sidebar-usage-model-picker");
  await usage.click();
  await expect(usage).toHaveCount(0);
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header).toBeFocused();
});
