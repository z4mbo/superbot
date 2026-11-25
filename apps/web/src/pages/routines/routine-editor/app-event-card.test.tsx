// @vitest-environment jsdom

import type { AppEventSource } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RoutineAppEventDraft } from "../../../lib/routines/routine-draft";
import { AppEventTriggerCard, newAppEventDraft } from "./app-event-card";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const repository = { key: "repository", label: "Repository", placeholder: "owner/name" };
const github: AppEventSource = {
  app: "github",
  name: "GitHub",
  connections: [{ id: "connection-1", name: "GitHub" }],
  events: [
    { id: "issue_added", label: "New issue", params: [repository] },
    { id: "commit", label: "New commit", params: [repository] },
  ],
};

async function render(value: RoutineAppEventDraft, sources = [github]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <AppEventTriggerCard
        value={value}
        sources={sources}
        onChange={onChange}
        onRemove={onRemove}
      />,
    ),
  );
  return { root, onChange, onRemove };
}

it("starts from the first event of the first connected account", () => {
  expect(newAppEventDraft(github)).toEqual({
    app: "github",
    event: "issue_added",
    connectionId: "connection-1",
    params: {},
  });
  expect(newAppEventDraft({ ...github, connections: [] })).toBeNull();
});

it("names what starts it and labels each setting", async () => {
  const { root, onChange, onRemove } = await render(newAppEventDraft(github)!);
  expect(document.body.textContent).toContain("GitHub: New issue");
  // One account and one app: nothing to choose between, so no picker for them.
  expect(document.body.textContent).not.toContain("Account");
  const input = document.querySelector<HTMLInputElement>('input[placeholder="owner/name"]')!;
  const label = document.querySelector(`label[for="${input.id}"]`);
  expect(label?.textContent).toBe("Repository");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "octo/hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { repository: "octo/hello" } }),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Remove app event"]')!.click(),
  );
  expect(onRemove).toHaveBeenCalled();
  root.unmount();
});

it("shows only what to do when its account is gone, and that a checked event is polled", async () => {
  const gone = await render(
    {
      app: "github",
      event: "issue_added",
      connectionId: "removed",
      params: { repository: "octo/hello" },
      label: "GitHub: New issue",
      error: "Reconnect the app to start this routine.",
    },
    [],
  );
  expect(document.body.textContent).toContain("Reconnect the app to start this routine.");
  expect(document.querySelector("input")).toBeNull();
  gone.root.unmount();
  document.body.replaceChildren();

  const checked = await render({ ...newAppEventDraft(github)!, checked: true, error: null });
  expect(document.body.textContent).toContain("Checked every 5 minutes");
  checked.root.unmount();
});
