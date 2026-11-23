import { describe, expect, it } from "vitest";
import { appReleaseDigest, checkAppBundle } from "./app-bundle.js";

const manifest = {
  id: "focus-timer",
  name: "Focus timer",
  version: "1.0.0",
  description: "A timer for focused work.",
  entry: "src/app.jsx",
  permissions: ["clipboard"],
};
const source = "export default function App() {\n  return <Text>Ready</Text>;\n}\n";
const entry = { path: "src/app.jsx", content: source, encoding: "utf8" as const };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString(
  "base64",
);

function errorsOf(input: Parameters<typeof checkAppBundle>[0]): string[] {
  const result = checkAppBundle(input);
  if (result.ok) throw new Error("expected the bundle to be refused");
  return result.errors;
}

describe("checkAppBundle", () => {
  it("accepts a manifest and its entry, compiled for the viewer", () => {
    const result = checkAppBundle({ manifest, files: [entry] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.manifest.permissions).toEqual(["clipboard"]);
    expect(result.bundle.code).toContain("Ready");
    expect(result.bundle.icon).toBeNull();
    expect(result.bundle.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("refuses an invalid manifest with the field that is wrong", () => {
    const errors = errorsOf({
      manifest: { ...manifest, permissions: ["clipboard", "filesystem"] },
      files: [entry],
    });
    expect(errors.some((error) => error.startsWith("app.json permissions"))).toBe(true);
  });

  it("refuses a manifest that sneaks in a field the schema does not know", () => {
    const errors = errorsOf({ manifest: { ...manifest, network: true }, files: [entry] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([
    ["../escape.jsx", "climbs out of the folder"],
    ["/etc/app.jsx", "absolute"],
    ["C:/app.jsx", "a drive"],
    ["src\\app.jsx", "backslashes"],
    ["src/CON.jsx", "a Windows reserved name"],
    ["src/aux", "a Windows reserved name without extension"],
    ["src/app.jsx.", "a trailing dot Windows drops"],
  ])("refuses the path %s (%s)", (path) => {
    const errors = errorsOf({
      manifest,
      files: [entry, { path, content: "x", encoding: "utf8" }],
    });
    expect(errors.some((error) => error.startsWith(`Path ${JSON.stringify(path)}`))).toBe(true);
  });

  it("refuses two files that collide on case-insensitive file systems", () => {
    const errors = errorsOf({
      manifest,
      files: [entry, { path: "SRC/App.jsx", content: source, encoding: "utf8" }],
    });
    expect(errors).toEqual(["SRC/App.jsx: another file has the same name on Windows and macOS."]);
  });

  it("refuses files the manifest does not use", () => {
    const errors = errorsOf({
      manifest,
      files: [entry, { path: "src/extra.jsx", content: source, encoding: "utf8" }],
    });
    expect(errors).toEqual(["src/extra.jsx: app.json does not use this file; leave it out."]);
  });

  it("refuses a missing entry and an entry the page kit rejects", () => {
    expect(errorsOf({ manifest, files: [{ ...entry, path: "src/other.jsx" }] })).toContain(
      "src/app.jsx: the entry file is missing.",
    );
    const broken = errorsOf({ manifest, files: [{ ...entry, content: "const x = ;" }] });
    expect(broken[0]).toMatch(/^src\/app\.jsx: /);
  });

  it("accepts an icon whose bytes match its name and refuses one that does not", () => {
    const withIcon = { ...manifest, icon: "icon.png" };
    const ok = checkAppBundle({
      manifest: withIcon,
      files: [entry, { path: "icon.png", content: PNG, encoding: "base64" }],
    });
    expect(ok.ok && ok.bundle.icon).toBe(`data:image/png;base64,${PNG}`);
    const html = Buffer.from("<svg onload=alert(1)>").toString("base64");
    expect(
      errorsOf({
        manifest: withIcon,
        files: [entry, { path: "icon.png", content: html, encoding: "base64" }],
      }),
    ).toEqual(["icon.png: the file is not the image its name says."]);
    expect(
      errorsOf({
        manifest: withIcon,
        files: [entry, { path: "icon.png", content: "not base64!", encoding: "base64" }],
      }),
    ).toEqual(["icon.png: send the icon as base64."]);
  });
});

describe("appReleaseDigest", () => {
  it("does not depend on key order, as a database may return keys in any order", () => {
    const release = { source, code: "code", icon: null };
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    expect(appReleaseDigest({ ...release, manifest: reordered })).toBe(
      appReleaseDigest({ ...release, manifest }),
    );
  });

  it("changes when a permission is added to the stored manifest", () => {
    const release = { source, code: "code", icon: null };
    expect(
      appReleaseDigest({
        ...release,
        manifest: { ...manifest, permissions: ["clipboard", "links"] },
      }),
    ).not.toBe(appReleaseDigest({ ...release, manifest }));
  });
});
