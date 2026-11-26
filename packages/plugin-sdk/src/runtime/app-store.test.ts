// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";
import { subscribeQuery } from "./app-store.js";

it("tells the host it is ready before it asks for its first query", async () => {
  const posted: { type?: string }[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message as { type?: string });
  });
  (globalThis as Record<string, unknown>).__rakazoApp = {
    permissions: ["data", "agent:read"],
    actions: [{ name: "day", description: "One day.", server: true, readOnly: true }],
    initialState: {},
  };
  document.documentElement.setAttribute("data-app-queries", "");

  // The host forgets what it follows when a view says it is ready, so ready must come first.
  const stop = subscribeQuery("day", {}, () => undefined);
  await flush();
  expect(posted.map((message) => message.type)).toEqual(["rakazo-app:ready", "rakazo-app:query"]);
  stop();
});
