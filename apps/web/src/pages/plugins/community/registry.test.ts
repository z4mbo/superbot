import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PluginDraft, RegistryVersion } from "./registry";
import {
  calorieDiaryDraft,
  changeField,
  checkDraft,
  draftFromJson,
  draftFromManifest,
  draftFromTemplate,
  emptyDraft,
  isUntouched,
  latestBySlug,
  manifestJson,
  newField,
  newPart,
  nextVersion,
  readAllPages,
  slugFromName,
} from "./registry";

function version(slug: string, number: number, name = slug): RegistryVersion {
  return {
    id: `${slug}-${number}`,
    slug,
    version: number,
    manifest: {
      schemaVersion: 1,
      name,
      description: `${name} helps`,
      parts: [{ id: "guide", kind: "skill", instructions: "Do it." }],
    },
    status: "approved",
    reason: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    reviewedAt: "2026-11-02T00:00:00.000Z",
  };
}

function draft(patch: Partial<PluginDraft> = {}): PluginDraft {
  return {
    ...emptyDraft(),
    name: "Release notes",
    slug: "release-notes",
    description: "Drafts release notes.",
    parts: [{ key: 1, kind: "skill", id: "notes", instructions: "Summarize issues." }],
    ...patch,
  };
}

describe("community registry helpers", () => {
  it("keeps the newest version of each plugin, sorted by name", () => {
    const rows = [
      version("zeta", 1, "Zeta"),
      version("alpha", 1, "Alpha"),
      version("zeta", 3, "Zeta"),
    ];
    expect(latestBySlug(rows).map((row) => row.id)).toEqual(["alpha-1", "zeta-3"]);
  });

  it("derives an ID from a name and the next version from an author's own", () => {
    expect(slugFromName("  Release Notes & Changelog! ")).toBe("release-notes-changelog");
    expect(slugFromName("Café")).toBe("cafe");
    const mine = [version("notes", 1), version("notes", 4), version("other", 9)];
    expect(nextVersion(mine, "notes")).toBe(5);
    expect(nextVersion(mine, "fresh")).toBe(1);
  });

  it("gives new parts IDs that are not taken", () => {
    const first = newPart("mcp", []);
    const second = newPart("mcp", [first]);
    expect([first.id, second.id]).toEqual(["tools", "tools-2"]);
  });

  it("builds the exact submit input from a valid draft", () => {
    const result = checkDraft(
      draft({
        name: "  Release notes ",
        version: "2",
        parts: [
          { key: 1, kind: "skill", id: "notes", instructions: "Summarize issues." },
          { key: 2, kind: "mcp", id: "tracker", endpoint: " https://tracker.example.test/mcp " },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      input: {
        slug: "release-notes",
        version: 2,
        manifest: {
          schemaVersion: 1,
          name: "Release notes",
          description: "Drafts release notes.",
          parts: [
            { id: "notes", kind: "skill", instructions: "Summarize issues." },
            {
              id: "tracker",
              kind: "mcp",
              transport: "streamable_http",
              endpoint: "https://tracker.example.test/mcp",
            },
          ],
        },
      },
    });
  });

  it("reports what the registry contract refuses, by field", () => {
    const result = checkDraft(
      draft({
        slug: "Release Notes",
        version: "0",
        parts: [
          { key: 1, kind: "mcp", id: "tools", endpoint: "http://tracker.example.test/mcp" },
          { key: 2, kind: "skill", id: "tools", instructions: "" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining([
        "slug",
        "version",
        "manifest.parts.0.endpoint",
        "manifest.parts.1.instructions",
      ]),
    );
  });

  it("refuses duplicate part IDs and endpoints with a query string", () => {
    const duplicate = checkDraft(
      draft({
        parts: [
          { key: 1, kind: "skill", id: "notes", instructions: "One." },
          { key: 2, kind: "skill", id: "notes", instructions: "Two." },
        ],
      }),
    );
    expect(duplicate.ok ? [] : duplicate.issues.map((issue) => issue.path.join("."))).toEqual([
      "manifest.parts",
    ]);
    const query = checkDraft(
      draft({
        parts: [
          { key: 1, kind: "mcp", id: "tools", endpoint: "https://tools.example.test/mcp?token=x" },
        ],
      }),
    );
    expect(query.ok).toBe(false);
  });

  it("loads a bare manifest or a whole submission from JSON", () => {
    const manifest = {
      schemaVersion: 1,
      name: "Unit converter",
      description: "Convert units.",
      parts: [
        {
          id: "temps",
          kind: "mcp",
          transport: "streamable_http",
          endpoint: "https://u.example.test/mcp",
        },
        { id: "guide", kind: "skill", instructions: "Use it." },
      ],
    };
    const bare = draftFromJson(JSON.stringify(manifest), emptyDraft());
    expect(bare).toMatchObject({ name: "Unit converter", slug: "unit-converter", version: "1" });
    expect(checkDraft(bare).ok).toBe(true);

    const wrapped = draftFromJson(
      JSON.stringify({ slug: "units", version: 3, manifest }),
      emptyDraft(),
    );
    expect(wrapped).toMatchObject({ slug: "units", version: "3", slugEdited: true });
    expect(wrapped.parts.map((part) => part.id)).toEqual(["temps", "guide"]);

    expect(() => draftFromJson("[1]", emptyDraft())).toThrow(SyntaxError);
    expect(() => draftFromJson("{", emptyDraft())).toThrow(SyntaxError);
  });

  it("reads every page of a list", async () => {
    const pages: Record<string, { items: number[]; nextAfter: string | null }> = {
      start: { items: [1, 2], nextAfter: "b" },
      b: { items: [3], nextAfter: "c" },
      c: { items: [4], nextAfter: null },
    };
    const seen: Array<string | undefined> = [];
    const items = await readAllPages(async (after) => {
      seen.push(after);
      return pages[after ?? "start"]!;
    });
    expect(items).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, "b", "c"]);
  });

  it("starts from the published calorie diary example under an ID of the author's own", async () => {
    const example = calorieDiaryDraft([version("calorie-diary", 2)]);
    expect(example).toMatchObject({ slug: "calorie-diary", slugEdited: false, version: "3" });
    expect(checkDraft(example).ok).toBe(true);
    const manifest = JSON.parse(manifestJson(example));
    const published = await readFile(
      new URL("../../../../../../examples/plugins/kcal-diary/plugin.json", import.meta.url),
      "utf8",
    );
    expect(manifest).toEqual(JSON.parse(published));
    const again = draftFromManifest(manifest, "calorie-diary", 4);
    expect(JSON.parse(manifestJson(again))).toEqual(manifest);
    expect(isUntouched(emptyDraft())).toBe(true);
    expect(isUntouched(example)).toBe(false);
  });

  it("reports app field problems where the author fixes them", () => {
    const example = calorieDiaryDraft([]);
    const [app] = example.parts;
    if (app?.kind !== "app") throw new Error("expected an app part");
    const broken = {
      ...example,
      parts: [
        {
          ...app,
          summaryField: "meal",
          fields: [...app.fields, newField({ label: "", id: "meal", idEdited: true })],
        },
      ],
    };
    const checked = checkDraft(broken);
    expect(checked.ok).toBe(false);
    const paths = checked.ok ? [] : checked.issues.map((issue) => issue.path.map(String).join("."));
    expect(paths).toEqual(
      expect.arrayContaining(["manifest.parts.0.fields.3.label", "manifest.parts.0.fields"]),
    );
  });

  it("lets a field ID follow its label until the author edits it", () => {
    const followed = changeField(newField(), { label: "Protein (g)" });
    expect(followed.id).toBe("protein-g");
    const edited = changeField(followed, { id: "protein" });
    expect(changeField(edited, { label: "Protein grams" }).id).toBe("protein");
  });

  it("starts a template under an ID of the author's own", () => {
    const template = draftFromTemplate(version("kcal-diary", 3, "Kcal diary"), [
      version("my-kcal-diary", 1),
    ]);
    expect(template).toMatchObject({ name: "Kcal diary", slug: "my-kcal-diary", version: "2" });
  });
});
