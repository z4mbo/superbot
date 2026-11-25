import { expect, test } from "@playwright/test";
import type { AppInstall, AppListing, AppSubmissionInput } from "@rakazo/contracts";
import { pageViewerCode } from "@rakazo/page-kit/compile";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

const source = `export default function FocusTimer() {
  return (
    <Page title="Focus timer">
      <Metrics
        metrics={[
          { value: "25 min", label: "Next session" },
          { value: "4", label: "Sessions today" },
        ]}
      />
      <Steps steps={[{ title: "Plan the task" }, { title: "Focus" }, { title: "Take a break" }]} />
    </Page>
  );
}
`;

test("Apps lists a reviewed app, asks for consent to add it, and opens it sandboxed", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `apps-${stamp}@rakazo.test`, "password12", "Apps Test");
  await completeOnboarding(page);

  // The real server takes the app for review: it checks the manifest and compiles the entry.
  const appId = `focus-timer-${stamp}`;
  const submission: AppSubmissionInput = {
    manifest: {
      id: appId,
      name: "Focus timer",
      version: "1.0.0",
      description: "Plan focused work in timed sessions.",
      entry: "app.jsx",
      permissions: ["clipboard", "links"],
    },
    files: [{ path: "app.jsx", content: source, encoding: "utf8" }],
  };
  const submitted = await rpc<{ status: string }>(page, "apps/submit", submission);
  expect(submitted.status).toBe("pending");

  // Approval needs a deployment admin, so review is stood in for from here: the store's own
  // reads and writes are answered as an approved listing would be.
  const listing: AppListing = {
    releaseId: "release-focus-timer",
    appId,
    name: "Focus timer",
    description: "Plan focused work in timed sessions.",
    version: "1.0.0",
    icon: null,
    permissions: ["clipboard", "links"],
    digest: `sha256:${"a".repeat(64)}`,
  };
  let listed = false;
  let installs: AppInstall[] = [];
  const installRequests: unknown[] = [];
  await page.route("**/rpc/apps/catalog", (route) =>
    route.fulfill({ json: { json: listed ? [listing] : [] } }),
  );
  await page.route("**/rpc/apps/installed", (route) => route.fulfill({ json: { json: installs } }));
  await page.route("**/rpc/apps/install", async (route) => {
    installRequests.push(route.request().postDataJSON().json);
    installs = [
      {
        id: "install-focus-timer",
        releaseId: listing.releaseId,
        appId,
        name: listing.name,
        description: listing.description,
        version: listing.version,
        icon: null,
        granted: listing.permissions,
        createdAt: "2026-11-23T09:00:00.000Z",
      },
    ];
    await route.fulfill({ json: { json: installs[0] } });
  });
  await page.route("**/rpc/apps/launch", (route) =>
    route.fulfill({
      json: {
        json: {
          installId: "install-focus-timer",
          appId,
          name: listing.name,
          version: listing.version,
          code: pageViewerCode(source),
          granted: listing.permissions,
        },
      },
    }),
  );

  const connect = page
    .getByTestId("sidebar-footer")
    .getByRole("button", { name: "Store", exact: true });
  await connect.click();
  const dialog = page.getByRole("dialog", { name: "Store", exact: true });
  await dialog.getByTestId("store-apps").click();
  await expect(dialog.getByTestId("community-store")).toBeVisible();
  await expect(dialog.getByTestId("app-section")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-baseline");
  await page.keyboard.press("Escape");

  listed = true;
  await connect.click();
  await dialog.getByTestId("store-apps").click();
  const section = dialog.getByTestId("app-section");
  await expect(section.getByText("Focus timer", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "app-store-browse");

  await section.getByRole("button", { name: "Add Focus timer", exact: true }).click();
  const detail = dialog.getByTestId("app-detail");
  await expect(detail.getByRole("heading", { name: "Focus timer", exact: true })).toBeVisible();
  await expect(detail.getByText("Copy text when you click", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "app-store-detail");

  await detail.getByRole("button", { name: "Add", exact: true }).click();
  const consent = page.getByRole("alertdialog", { name: "Allow Focus timer to:" });
  await expect(consent.getByText("Open links you confirm", { exact: true })).toBeVisible();
  expect(installRequests).toEqual([]);
  await captureScreenshot(page, testInfo, "app-store-permission-prompt");
  await consent.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(consent).toHaveCount(0);
  // Consent covers the version that was shown and every permission it asks for.
  expect(installRequests).toEqual([
    { releaseId: listing.releaseId, digest: listing.digest, grant: ["clipboard", "links"] },
  ]);

  await expect(detail.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "app-store-installed");
  await detail.getByRole("button", { name: "Open", exact: true }).click();
  // The viewer shell frames the app's own document, as it does for pages.
  const frame = detail
    .getByTestId("app-frame")
    .locator("iframe")
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
  await expect(frame.getByText("25 min", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "app-store-opened");
});
