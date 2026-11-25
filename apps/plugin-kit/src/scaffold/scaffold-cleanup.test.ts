import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { scaffold } from "./scaffold.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn((file: string, flags: string) =>
      file.endsWith("temperature.html")
        ? Promise.reject(Object.assign(new Error("disk full"), { code: "EFIXTURE" }))
        : actual.open(file, flags),
    ),
  };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("removes the files it created when a later one cannot be written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbot-plugin-cleanup-"));
  directories.push(dir);
  await expect(
    scaffold("plugin.json", "temperature-tool", undefined, "mcp-app", dir),
  ).rejects.toThrow("Creating temperature.html: disk full");
  expect(await readdir(dir)).toEqual([]);
});
