import { expect, test } from "@playwright/test";
import type {
  Bot,
  CommunityTemplateListing,
  CommunityTemplateSubmission,
} from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, makeAdmin, rpc, signup } from "../helpers/helpers";

const INSTRUCTIONS = "You write a weekly digest of what changed. Never send email for the user.";

// Sharing runs against the real server. This server has no admins, so the review and the listing
// it leads to are answered here from what was really submitted; the product suite covers the
// server's review, listing and create path against Postgres.
test("a bot is shared as a template, approved, listed under Community and made into a bot", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const stamp = Date.now();
  await signup(page, `community-${stamp}@rakazo.test`, "password12", "Community Author");
  await completeOnboarding(page);
  const name = `Weekly digest ${stamp}`;
  const bot = await rpc<Bot>(page, "bots/create", {
    name,
    description: "Weekly digest",
    instructions: INSTRUCTIONS,
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "routines/create", {
    botId: bot.id,
    name: "Friday digest",
    prompt: "Send this week's digest.",
    crons: ["0 9 * * 5"],
  });
  await page.reload();

  // Share: everything read from the bot is shown, and the author completes the rest.
  await page.locator("aside").first().getByRole("button", { name }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as template", exact: true }).click();
  const share = page.getByTestId("share-template-dialog");
  await expect(share.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(share.getByLabel("Instructions", { exact: true })).toHaveValue(INSTRUCTIONS);
  await expect(share.getByLabel("Routine name")).toHaveValue("Friday digest");
  const submit = share.getByRole("button", { name: "Submit for review", exact: true });
  await expect(submit).toBeDisabled();
  await share.getByLabel("Category", { exact: true }).click();
  await page.getByRole("option", { name: "Research", exact: true }).click();
  await share.getByLabel("Summary", { exact: true }).fill("What changed this week, in one list");
  await share.getByLabel("Example message", { exact: true }).fill("**This week**\n- Two releases");
  await captureScreenshot(page, testInfo, "agents-share-dialog");
  await submit.click();
  await expect(share).toHaveCount(0);

  const [submitted] = await rpc<CommunityTemplateSubmission[]>(
    page,
    "communityTemplates/mine",
    {},
  );
  expect(submitted).toMatchObject({ status: "pending", author: "Community Author" });
  expect(submitted!.recipe.instructions).toBe(INSTRUCTIONS);

  // Review: an admin sees the whole recipe and approves it.
  const reviews: unknown[] = [];
  await page.route("**/rpc/me", (route) => makeAdmin(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, "bootstrap"));
  await page.route("**/rpc/communityTemplates/queue", (route) =>
    route.fulfill({ json: { json: reviews.length ? [] : [submitted] } }),
  );
  await page.route("**/rpc/communityTemplates/review", async (route) => {
    reviews.push((route.request().postDataJSON() as { json: unknown }).json);
    await route.fulfill({ json: { json: { ...submitted, status: "approved" } } });
  });
  await page.goto("/admin/apps");
  const review = page.getByTestId("community-template-review");
  const item = review.getByTestId("community-template-submission");
  await expect(item).toContainText(name);
  await expect(item).toContainText(INSTRUCTIONS);
  await expect(item).toContainText("Send this week's digest.");
  await captureScreenshot(page, testInfo, "agents-review-queue");
  await item.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(review.getByText("No shared agents")).toBeVisible();
  expect(reviews).toEqual([{ id: submitted!.id, decision: "approve" }]);

  // Listing: the approved template appears under Community with its author.
  const listing: CommunityTemplateListing = {
    ...submitted!.recipe,
    id: submitted!.slug,
    version: submitted!.version,
    botId: null,
    author: submitted!.author,
  };
  const made = await rpc<Bot>(page, "bots/create", {
    name: `${name} copy`,
    description: "",
    instructions: INSTRUCTIONS,
    notifyOnFinish: true,
    computerMode: "team",
  });
  const creates: unknown[] = [];
  await page.route("**/rpc/communityTemplates/list", (route) =>
    route.fulfill({ json: { json: [listing] } }),
  );
  await page.route("**/rpc/bots/createFromTemplate", async (route) => {
    creates.push((route.request().postDataJSON() as { json: unknown }).json);
    await route.fulfill({ json: { json: { bot: made, created: true } } });
  });
  await page.goto(`/app/${bot.id}?templates`);
  const store = page.getByRole("dialog", { name: "Store", exact: true });
  const community = store.getByTestId("bot-template-group").filter({ hasText: "Community" });
  const card = community.getByRole("button", { name, exact: true });
  await expect(card).toContainText("Shared by Community Author");
  await expect(store.getByTestId("my-shared-templates")).toContainText("Waiting for review");
  await store.getByRole("button", { name: "Research", exact: true }).click();
  await expect(card).toBeVisible();
  await captureScreenshot(page, testInfo, "agents-community-group");

  await card.click();
  const detail = store.getByTestId("bot-template-detail");
  await expect(detail.getByTestId("bot-template-author")).toHaveText("Shared by Community Author");
  await expect(detail.getByText(INSTRUCTIONS)).toBeVisible();
  await detail.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(store).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/app/${made.id}`));
  expect(creates).toEqual([{ templateId: listing.id, version: listing.version, name }]);
});
