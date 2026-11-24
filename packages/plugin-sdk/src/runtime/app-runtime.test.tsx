// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkApp } from "../check/check-app.js";

const manifest = {
  id: "counter",
  name: "Counter",
  version: "1.0.0",
  description: "Counts.",
  entry: "app.jsx",
  permissions: ["state"],
  initialState: { count: 0 },
  actions: [
    { name: "bump", description: "Add one.", effects: [{ op: "increment", path: "count" }] },
  ],
};
const source = `export default function Counter() {
  const state = useAppState();
  return (
    <Page title="Counter">
      <Text>{"Count " + String(state.count)}</Text>
      <ActionButton action="bump" label="Add" />
    </Page>
  );
}
`;

type Mount = { mount: (boot: object) => void };
const posted: unknown[] = [];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  posted.length = 0;
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  // jsdom runs no inline scripts, so run the app's script the way a browser would.
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) new Function(node.text)();
    }
    append(...nodes);
  });
  await import("./app-runtime.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountApp(stored?: { state: object; revision: number }) {
  const checked = checkApp({ manifest, source });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  if (stored) (globalThis as Record<string, unknown>).__rakazoAppState = stored;
  document.body.replaceChildren();
  const page = (window as unknown as { RakazoPage: Mount }).RakazoPage;
  await act(async () => {
    page.mount({ code: checked.code, theme: "light", errorTitle: "This page couldn't be shown." });
    await flush();
  });
}

function button() {
  return [...document.querySelectorAll("button")].find((node) => node.textContent === "Add")!;
}

it("shows stored state, asks the host to run an action, and draws the state it sends back", async () => {
  document.documentElement.setAttribute("data-app-actions", "");
  await mountApp({ state: { count: 4 }, revision: 2 });
  expect(document.body.textContent).toContain("Count 4");
  await act(async () => {
    button().click();
    await flush();
  });
  const request = posted.find(
    (message) => (message as { type?: string }).type === "rakazo-app:action",
  ) as { id: string; name: string; input: unknown };
  expect(request).toMatchObject({ name: "bump", input: {} });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "rakazo-app:state", state: { count: 5 }, revision: 3 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "rakazo-app:result", id: request.id, ok: true },
      }),
    );
    await flush();
  });
  expect(document.body.textContent).toContain("Count 5");
  // An older state that arrives late does not roll the app back.
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "rakazo-app:state", state: { count: 1 }, revision: 1 },
      }),
    );
    await flush();
  });
  expect(document.body.textContent).toContain("Count 5");
});

it("ignores state that does not come from the host", async () => {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: null,
        data: { type: "rakazo-app:state", state: { count: 99 }, revision: 50 },
      }),
    );
    await flush();
  });
  expect(document.body.textContent).not.toContain("Count 99");
});

it("disables actions where the host cannot run them", async () => {
  document.documentElement.removeAttribute("data-app-actions");
  await mountApp();
  expect(button().disabled).toBe(true);
});

it("sends an ActionForm's fields with a click, without a form submission", async () => {
  document.documentElement.setAttribute("data-app-actions", "");
  const checked = checkApp({
    manifest: {
      ...manifest,
      actions: [
        {
          name: "add",
          description: "Add.",
          input: { title: { type: "string", description: "Title", required: true } },
          effects: [{ op: "append", path: "items" }],
        },
      ],
    },
    source: `export default function Form() {\n  return <Page title="Form"><ActionForm action="add" label="Add" /></Page>;\n}\n`,
  });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  document.body.replaceChildren();
  const page = (window as unknown as { RakazoPage: Mount }).RakazoPage;
  await act(async () => {
    page.mount({ code: checked.code, theme: "light", errorTitle: "x" });
    await flush();
  });
  expect(document.querySelector("form")).toBeNull();
  // A fieldset is a group named by the action's label.
  expect(document.querySelector("fieldset")?.getAttribute("aria-label")).toBe("Add");
  const input = document.querySelector("input")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Milk");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    button().click();
    await flush();
  });
  expect(posted).toContainEqual(
    expect.objectContaining({ type: "rakazo-app:action", name: "add", input: { title: "Milk" } }),
  );
});
