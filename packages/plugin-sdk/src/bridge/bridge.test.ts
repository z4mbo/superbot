import { appManifestSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { appActionRequest, appActionResult, appBridgeAllows } from "./bridge.js";

function app(permissions: string[]) {
  return appManifestSchema.parse({
    id: "test-app",
    name: "Test",
    version: "1.0.0",
    description: "Test.",
    entry: "app.jsx",
    permissions,
    actions: permissions.includes("state")
      ? [{ name: "bump", description: "Bump.", effects: [{ op: "increment", path: "n" }] }]
      : [],
  });
}

describe("appBridgeAllows", () => {
  it("lets a person run declared actions of an app with state", () => {
    expect(
      appBridgeAllows(app(["state"]), { by: "person", kind: "action", action: "bump" }),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses actions the manifest does not declare, whoever asks", () => {
    const full = app(["state", "agent:read", "agent:actions"]);
    for (const by of ["person", "agent"] as const) {
      for (const action of ["drop", "", "toString", "__proto__", "constructor", "BUMP"]) {
        expect(appBridgeAllows(full, { by, kind: "action", action }).ok).toBe(false);
      }
    }
  });

  it("keeps bots out unless the manifest lets them in", () => {
    const own = app(["state"]);
    expect(appBridgeAllows(own, { by: "agent", kind: "read" })).toEqual({
      ok: false,
      error: "This app does not let bots read its state.",
    });
    expect(appBridgeAllows(own, { by: "agent", kind: "action", action: "bump" })).toEqual({
      ok: false,
      error: "This app does not let bots run its actions.",
    });
    const readOnly = app(["state", "agent:read"]);
    expect(appBridgeAllows(readOnly, { by: "agent", kind: "read" }).ok).toBe(true);
    expect(appBridgeAllows(readOnly, { by: "agent", kind: "action", action: "bump" }).ok).toBe(
      false,
    );
  });

  it("refuses an app's reply, link and copy requests it did not declare", () => {
    const none = app([]);
    for (const kind of ["reply", "links", "clipboard"] as const) {
      expect(appBridgeAllows(none, { by: "person", kind }).ok).toBe(false);
      expect(appBridgeAllows(app([kind]), { by: "person", kind }).ok).toBe(true);
    }
  });

  it("refuses a manifest that claims an action without the state permission", () => {
    // A stored manifest is parsed again before use; a forged one still gets no actions.
    const forged = {
      permissions: ["agent:actions" as const],
      actions: app(["state"]).actions,
    };
    expect(appBridgeAllows(forged, { by: "agent", kind: "action", action: "bump" }).ok).toBe(false);
    expect(appBridgeAllows(forged, { by: "person", kind: "action", action: "bump" }).ok).toBe(
      false,
    );
  });
});

describe("appActionRequest", () => {
  it("reads a well-formed request", () => {
    expect(
      appActionRequest({ type: "rakazo-app:action", id: "a1", name: "bump", input: { n: 1 } }),
    ).toEqual({ id: "a1", name: "bump", input: { n: 1 } });
  });

  it.each([
    null,
    "rakazo-app:action",
    { type: "rakazo-page:copy", id: "a1", name: "bump" },
    { type: "rakazo-app:action", id: 1, name: "bump" },
    { type: "rakazo-app:action", id: "", name: "bump" },
    { type: "rakazo-app:action", id: "x".repeat(65), name: "bump" },
    { type: "rakazo-app:action", id: "a1", name: "" },
    { type: "rakazo-app:action", id: "a1", name: "x".repeat(65) },
    { type: "rakazo-app:action", id: "a1", name: ["bump"] },
  ])("ignores %j", (data) => {
    expect(appActionRequest(data)).toBeNull();
  });
});

it("cuts a long error before it goes back into the app", () => {
  expect(appActionResult("a1", { ok: false, error: "x".repeat(400) })).toEqual({
    type: "rakazo-app:result",
    id: "a1",
    ok: false,
    error: "x".repeat(300),
  });
});
