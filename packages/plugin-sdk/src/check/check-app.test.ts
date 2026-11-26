import { checkPageSource } from "@rakazo/page-kit/validate";
import { describe, expect, it } from "vitest";
import { APP_GLOBALS, APP_SURFACE_GLOBAL, checkApp } from "./check-app.js";

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
  const bump = useAction("bump");
  return (
    <Page title="Counter">
      <Text>{String(state.count)}</Text>
      <ActionButton action="bump" label="Add" />
      <Button label="Also add" onClick={() => bump()} />
    </Page>
  );
}
`;

describe("checkApp", () => {
  it("passes an app and compiles its surface into the viewer code", () => {
    const result = checkApp({ manifest, source });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code.startsWith(`"use strict";globalThis.${APP_SURFACE_GLOBAL}=`)).toBe(true);
    // Effects run on the server only; the viewer never sees them.
    expect(result.code).not.toContain("increment");
    expect(result.code).toContain('"initialState":{"count":0}');
  });

  it("refuses an invalid manifest", () => {
    const result = checkApp({ manifest: { ...manifest, version: "one" }, source });
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining("version")] });
  });

  it("refuses code that runs an action the manifest does not declare", () => {
    const result = checkApp({
      manifest,
      source: source.replace('useAction("bump")', 'useAction("wipe")'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain(
        'The code runs "wipe", which app.json does not declare in actions.',
      );
  });

  it("refuses an effect that names an input the action lacks", () => {
    const broken = {
      ...manifest,
      actions: [
        {
          name: "bump",
          description: "x",
          effects: [{ op: "increment", path: "count", from: "by" }],
        },
      ],
    };
    const result = checkApp({ manifest: broken, source });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["a script element", "<script>alert(1)</script>"],
    ["an iframe", '<iframe src="https://example.com" />'],
    ["require", "{require('fs')}"],
    ["a string handler", '<button onClick="steal()">x</button>'],
  ])("keeps the page kit's rules for %s", (_label, element) => {
    const hostile = source.replace("<Text>", `${element}<Text>`);
    expect(checkApp({ manifest, source: hostile }).ok).toBe(false);
  });

  it("refuses imports beyond react and the kit", () => {
    const hostile = `import fs from "node:fs";\n${source}`;
    expect(checkApp({ manifest, source: hostile }).ok).toBe(false);
  });

  it("refuses an app hook called while the file loads", () => {
    const hostile = `const early = useAppState();\n${source}`;
    const result = checkApp({ manifest, source: hostile });
    expect(result.ok).toBe(false);
  });
});

it("offers the app names only to apps", () => {
  const plain = checkPageSource(
    "export default function P() { return <Page><ActionButton action='x' label='x' /></Page>; }",
  );
  expect(plain.ok).toBe(false);
  expect(APP_GLOBALS).toEqual([
    "useAppState",
    "useAction",
    "useQuery",
    "useCard",
    "ActionButton",
    "ActionForm",
  ]);
});
