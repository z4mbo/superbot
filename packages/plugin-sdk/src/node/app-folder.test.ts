import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAppFolder, normalizeAppText } from "./app-folder.js";

const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/team-dashboard",
);

const manifest = {
  id: "folder-app",
  name: "Folder app",
  version: "0.1.0",
  description: "From a folder.",
  entry: "src/main.jsx",
};
const source = 'export default function App() {\n  return <Page title="Hi" />;\n}\n';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rakazo-app-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relative: string, text: string) {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("checkAppFolder", () => {
  it("passes the example dashboard", async () => {
    const result = await checkAppFolder(EXAMPLE);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.manifest.id).toBe("team-dashboard");
  });

  it("reads files written with a byte-order mark and CRLF line ends", async () => {
    await write("app.json", `﻿${JSON.stringify(manifest, null, 2).replace(/\n/g, "\r\n")}`);
    await write("src/main.jsx", `﻿${source.replace(/\n/g, "\r\n")}`);
    const result = await checkAppFolder(root);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code).not.toContain("\r");
  });

  it("reports line numbers that match on every system", async () => {
    await write("app.json", JSON.stringify(manifest));
    await write("src/main.jsx", "\r\n\r\nexport default function App() { return <Nope />; }\r\n");
    const result = await checkAppFolder(root);
    expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/^line 3: <Nope>/)] });
  });

  it("needs the entry's exact case, even where the disk ignores case", async () => {
    await write("app.json", JSON.stringify(manifest));
    await write("src/Main.jsx", source);
    const result = await checkAppFolder(root);
    expect(result).toEqual({
      ok: false,
      errors: [expect.stringContaining('the folder has "Main.jsx"')],
    });
  });

  it("refuses an entry that is missing or climbs out", async () => {
    await write("app.json", JSON.stringify(manifest));
    expect((await checkAppFolder(root)).ok).toBe(false);
    await write("app.json", JSON.stringify({ ...manifest, entry: "../outside.jsx" }));
    expect((await checkAppFolder(root)).ok).toBe(false);
  });

  it("refuses an entry that links outside the folder", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "rakazo-outside-"));
    try {
      await writeFile(path.join(outside, "main.jsx"), source);
      await write("app.json", JSON.stringify({ ...manifest, entry: "src/main.jsx" }));
      await mkdir(path.join(root, "src"));
      try {
        // Windows needs a junction for a link without extra privileges.
        await symlink(outside, path.join(root, "src", "link"), "junction");
      } catch {
        return;
      }
      await write("app.json", JSON.stringify({ ...manifest, entry: "src/link/main.jsx" }));
      const result = await checkAppFolder(root);
      expect(result).toEqual({
        ok: false,
        errors: ["src/link/main.jsx leads outside the app folder."],
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a folder that does not exist and a manifest that is not JSON", async () => {
    expect((await checkAppFolder(path.join(root, "missing"))).ok).toBe(false);
    await write("app.json", "{ id: ");
    const result = await checkAppFolder(root);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining("not valid JSON")] });
  });
});

it("normalizes line ends", () => {
  expect(normalizeAppText("﻿a\r\nb\rc\n")).toBe("a\nb\nc\n");
});
