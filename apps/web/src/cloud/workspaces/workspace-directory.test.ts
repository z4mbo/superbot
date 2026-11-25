import { describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "./workspace-directory.js";
import {
  createWorkspaceDirectory,
  normalizeWorkspaceUrl,
  readWorkspaces,
  WorkspaceUrlError,
} from "./workspace-directory.js";

describe("normalizeWorkspaceUrl", () => {
  it.each([
    ["bots.example.com", "https://bots.example.com"],
    ["  https://Bots.Example.com/  ", "https://bots.example.com"],
    ["https://bots.example.com:443", "https://bots.example.com"],
    ["https://bots.example.com:8443", "https://bots.example.com:8443"],
    ["bots.tail1234.ts.net", "https://bots.tail1234.ts.net"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["localhost:5173", "https://localhost:5173"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
    ["http://localhost:80", "http://localhost"],
  ])("accepts %s as %s", (input, url) => {
    expect(normalizeWorkspaceUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    ["", "invalid"],
    ["   ", "invalid"],
    ["https://", "invalid"],
    ["bots example.com", "invalid"],
    ["ftp://bots.example.com", "invalid"],
    ["javascript:alert(1)", "invalid"],
    ["http://bots.example.com", "insecure"],
    ["http://192.168.1.10:5173", "insecure"],
    ["http://localhost.example.com", "insecure"],
    ["https://bots.example.com/app", "not-an-origin"],
    ["https://bots.example.com//", "not-an-origin"],
    ["https://bots.example.com?x=1", "not-an-origin"],
    ["https://bots.example.com/?", "not-an-origin"],
    ["https://bots.example.com#top", "not-an-origin"],
    ["https://me:secret@bots.example.com", "not-an-origin"],
    ["https://me@bots.example.com", "not-an-origin"],
  ])("refuses %j as %s", (input, problem) => {
    expect(normalizeWorkspaceUrl(input)).toEqual({ ok: false, problem });
  });
});

type MemoryDocument = WorkspaceDocument & { value: unknown; writes: number };

function memoryDocument(initial: unknown = null): MemoryDocument {
  const document: MemoryDocument = {
    value: initial,
    writes: 0,
    read: async () => structuredClone(document.value),
    write: async (value) => {
      document.writes += 1;
      document.value = structuredClone(value);
    },
  };
  return document;
}

function directoryOver(document: WorkspaceDocument) {
  let next = 0;
  return createWorkspaceDirectory(document, {
    now: () => new Date("2026-11-25T10:00:00.000Z"),
    newId: () => `w${++next}`,
  });
}

describe("workspace directory", () => {
  it("starts empty and adds workspaces with their origin, a trimmed name and the time", async () => {
    const document = memoryDocument();
    const directory = directoryOver(document);
    expect(await directory.list()).toEqual([]);

    const added = await directory.add({ name: "  Home  ", url: "bots.example.com/" });
    expect(added).toEqual({
      id: "w1",
      name: "Home",
      url: "https://bots.example.com",
      kind: "self-hosted",
      addedAt: "2026-11-25T10:00:00.000Z",
    });
    expect(await directory.list()).toEqual([added]);
    expect(document.value).toEqual([added]);
  });

  it("names a workspace after its host when no name is given", async () => {
    const directory = directoryOver(memoryDocument());
    const added = await directory.add({ name: "   ", url: "http://localhost:5173" });
    expect(added.name).toBe("localhost:5173");
  });

  it("refuses a bad address or one already listed, without writing", async () => {
    const document = memoryDocument();
    const directory = directoryOver(document);
    await directory.add({ name: "Home", url: "https://bots.example.com" });
    const writes = document.writes;

    await expect(directory.add({ name: "Again", url: "BOTS.example.com" })).rejects.toEqual(
      new WorkspaceUrlError("duplicate"),
    );
    await expect(
      directory.add({ name: "Plain", url: "http://bots.example.com" }),
    ).rejects.toMatchObject({ problem: "insecure" });
    await expect(directory.add({ name: "Path", url: "https://x.example/a" })).rejects.toMatchObject(
      { problem: "not-an-origin" },
    );
    expect(document.writes).toBe(writes);
  });

  it("renames and removes, keeping the others", async () => {
    const directory = directoryOver(memoryDocument());
    const home = await directory.add({ name: "Home", url: "https://home.example" });
    const work = await directory.add({ name: "Work", url: "https://work.example" });

    await directory.rename(home.id, "  Living room ");
    await directory.rename(work.id, "");
    expect((await directory.list()).map((workspace) => workspace.name)).toEqual([
      "Living room",
      "work.example",
    ]);

    await directory.remove(home.id);
    expect((await directory.list()).map((workspace) => workspace.id)).toEqual([work.id]);
  });

  it("does nothing for an id that is not listed", async () => {
    const document = memoryDocument();
    const directory = directoryOver(document);
    await directory.add({ name: "Home", url: "https://home.example" });
    const writes = document.writes;
    await directory.rename("gone", "New");
    await directory.remove("gone");
    expect(document.writes).toBe(writes);
  });

  it("drops malformed stored entries instead of failing", async () => {
    const valid = {
      id: "a",
      name: "Home",
      url: "https://home.example",
      kind: "self-hosted",
      addedAt: "2026-01-01T00:00:00.000Z",
    };
    const stored = [
      valid,
      { ...valid, id: "b", url: "http://plain.example" },
      { ...valid, id: "c", url: "https://home.example/path" },
      { ...valid, id: "d", kind: "other" },
      { ...valid, id: "" },
      { ...valid, name: 3 },
      { ...valid, url: "https://dup-id.example" },
      "nonsense",
      null,
    ];
    expect(readWorkspaces(stored)).toEqual([valid]);
    expect(readWorkspaces({ workspaces: stored })).toEqual([]);
    expect(readWorkspaces(undefined)).toEqual([]);

    const directory = directoryOver(memoryDocument(stored));
    expect(await directory.list()).toEqual([valid]);
  });

  it("runs two quick changes one after the other so neither is lost", async () => {
    const directory = directoryOver(memoryDocument());
    const [home, work] = await Promise.all([
      directory.add({ name: "Home", url: "https://home.example" }),
      directory.add({ name: "Work", url: "https://work.example" }),
    ]);
    expect((await directory.list()).map((workspace) => workspace.id)).toEqual([home.id, work.id]);
  });

  it("keeps working after a failed change", async () => {
    const document = memoryDocument();
    const directory = directoryOver(document);
    const write = document.write;
    document.write = async () => {
      throw new Error("offline");
    };
    await expect(directory.add({ name: "Home", url: "https://home.example" })).rejects.toThrow(
      "offline",
    );
    document.write = write;
    await directory.add({ name: "Home", url: "https://home.example" });
    expect(await directory.list()).toHaveLength(1);
  });
});
