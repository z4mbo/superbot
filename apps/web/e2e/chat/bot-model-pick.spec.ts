import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotSettings,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

const MAIN_MODEL = "rakazo-e2e-main";
const PICKED_MODEL = "rakazo-e2e-picked";
// Nothing listens here: runs in this suite are scripted and never call the endpoint.
const FIXTURE_ENDPOINT = "http://127.0.0.1:8090/v1";

type BotRow = {
  id: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};
type RunRow = { status: string; modelProvider: string | null; modelId: string | null };

test("a model picked for a bot in chat is saved and runs its next turn", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-model-pick-${stamp}@rakazo.test`, "password12", "Model Pick");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  // The first connection becomes the main model; the second is offered beside it.
  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    apiKey: "fake-main-model-key",
    modelId: MAIN_MODEL,
    baseUrl: FIXTURE_ENDPOINT,
  });
  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    apiKey: "fake-picked-model-key",
    modelId: PICKED_MODEL,
    baseUrl: FIXTURE_ENDPOINT,
    reasoning: true,
    credentialId: null,
    makeDefault: false,
  });

  const settings = await openUserSettings(page);
  // The chat capsule shows the model by default.
  await expect(settings.getByTestId("composer-model-picker-toggle")).toBeChecked();
  await settings.getByTestId("settings-nav-models").click();
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(
    settings.getByTestId("model-role-main").getByTestId("model-role-row-1"),
  ).toContainText(MAIN_MODEL);
  await captureScreenshot(page, testInfo, "settings-models");

  await page.goto(`/app/${botId}`);
  const picker = page.getByTestId("chat-capsule").getByRole("button", { name: /^Model/ });
  // A bot that picked nothing shows the main model it follows.
  await expect(picker).toContainText(MAIN_MODEL);
  await captureScreenshot(page, testInfo, "bot-model-before");

  await picker.click();
  const option = page.getByRole("option", { name: new RegExp(`^${PICKED_MODEL}\\b`) });
  await expect(option).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-model-picker-open");
  const modelSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await option.click();
  await modelSaved;
  await expect(picker).toContainText(PICKED_MODEL);
  // A model that thinks keeps the list open on its levels.
  const thinkingSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await page.getByRole("option", { name: "High", exact: true }).click();
  await thinkingSaved;
  await expect(picker).toContainText("High");
  await captureScreenshot(page, testInfo, "bot-model-after");

  const saved = (await rpc<BotRow[]>(page, "bots/list", {})).find((row) => row.id === botId);
  expect(saved).toMatchObject({
    modelProvider: "openai-compatible",
    modelId: PICKED_MODEL,
    thinkingLevel: "high",
  });

  await page.reload();
  await expect(picker).toContainText(PICKED_MODEL);
  await openBotSettings(page);
  await expect(
    page.getByTestId("bot-settings").getByRole("button", { name: /^Model/ }),
  ).toContainText(PICKED_MODEL);
  await captureScreenshot(page, testInfo, "bot-settings-model");

  // The scripted turn stops on a question, so the run stays readable with the model it started on.
  await page
    .getByRole("combobox", { name: /^Message/ })
    .fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => (await rpc<{ run?: RunRow | null }>(page, "threads/get", { botId })).run ?? null,
      { timeout: 60_000 },
    )
    .toMatchObject({
      status: "waiting_input",
      modelProvider: "openai-compatible",
      modelId: PICKED_MODEL,
    });
});
