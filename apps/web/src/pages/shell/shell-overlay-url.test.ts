import { describe, expect, it } from "vitest";
import {
  readShellOverlay,
  searchString,
  shellOverlaySearch,
  storeOverlay,
  storeSection,
  withShellOverlay,
} from "./shell-overlay-url";

const read = (search: string) => readShellOverlay(new URLSearchParams(search));

describe("readShellOverlay", () => {
  it("opens nothing without overlay params", () => {
    expect(read("")).toBeNull();
    expect(read("?m=msg_1&routine=r_1")).toBeNull();
  });

  it("opens a settings section, falling back to general for bare or unknown values", () => {
    expect(read("?settings=voice")).toEqual({ kind: "settings", section: "voice", spaceId: null });
    expect(read("?settings=space&space=sp_1")).toEqual({
      kind: "settings",
      section: "space",
      spaceId: "sp_1",
    });
    expect(read("?settings")).toEqual({ kind: "settings", section: "general", spaceId: null });
    expect(read("?settings=nope")).toEqual({ kind: "settings", section: "general", spaceId: null });
  });

  it("binds settings to a space only alongside settings", () => {
    expect(read("?settings=models&space=sp_1")).toEqual({
      kind: "settings",
      section: "models",
      spaceId: "sp_1",
    });
    expect(read("?space=sp_1")).toBeNull();
  });

  it("reads flag overlays with or without a value", () => {
    expect(read("?connections")).toEqual({ kind: "connections" });
    expect(read("?mcp=")).toEqual({ kind: "mcp" });
    expect(read("?mcp=srv_1")).toEqual({ kind: "mcp", serverId: "srv_1" });
  });

  it("opens Messaging settings from the old messaging link", () => {
    expect(read("?messaging")).toEqual({ kind: "settings", section: "messaging", spaceId: null });
  });
});

describe("withShellOverlay", () => {
  const write = (search: string, overlay: Parameters<typeof withShellOverlay>[1]) =>
    searchString(withShellOverlay(new URLSearchParams(search), overlay));

  it("keeps unrelated params and writes flags bare", () => {
    expect(write("?m=msg_1", { kind: "connections" })).toBe("?m=msg_1&connections");
  });

  it("replaces the open overlay instead of stacking another", () => {
    expect(write("?connections&routine=r_1", { kind: "mcp" })).toBe("?routine=r_1&mcp");
    expect(write("", { kind: "mcp", serverId: "srv_1" })).toBe("?mcp=srv_1");
    expect(write("?settings=models&space=sp_1", { kind: "connections" })).toBe("?connections");
  });

  it("writes the settings section and space", () => {
    expect(write("", { kind: "settings", section: "models", spaceId: "sp_1" })).toBe(
      "?settings=models&space=sp_1",
    );
    expect(write("?space=sp_1", { kind: "settings", section: "usage", spaceId: null })).toBe(
      "?settings=usage",
    );
  });

  it("closing removes only overlay params", () => {
    expect(write("?m=msg_1&settings=voice&space=sp_1", null)).toBe("?m=msg_1");
    expect(write("?mcp", null)).toBe("");
  });

  it("round-trips through readShellOverlay", () => {
    const overlay = { kind: "settings", section: "billing", spaceId: "sp_2" } as const;
    expect(readShellOverlay(withShellOverlay(new URLSearchParams(), overlay))).toEqual(overlay);
  });
});

describe("shellOverlaySearch", () => {
  it("carries only the overlay into a redirect", () => {
    expect(shellOverlaySearch(new URLSearchParams("?m=msg_1&settings=voice"))).toBe(
      "?settings=voice",
    );
    expect(shellOverlaySearch(new URLSearchParams("?routine=r_1"))).toBe("");
  });
});

describe("Store sections", () => {
  it("opens each Store section from its own link, including the links its dialogs had", () => {
    expect(storeSection(read("?templates"))).toBe("agents");
    expect(storeSection(read("?skills"))).toBe("skills");
    expect(storeSection(read("?apps"))).toBe("apps");
    expect(storeSection(read("?connections"))).toBe("connections");
    expect(storeSection(read("?mcp"))).toBeNull();
    expect(storeSection(null)).toBeNull();
  });

  it("opens Apps and Connections from the links they had before they were renamed", () => {
    expect(read("?plugins")).toEqual({ kind: "apps" });
    expect(read("?integrations")).toEqual({ kind: "connections" });
    expect(storeSection(read("?plugins"))).toBe("apps");
    expect(storeSection(read("?integrations"))).toBe("connections");
  });

  it("replaces an old Store link with the current one", () => {
    expect(
      searchString(
        withShellOverlay(new URLSearchParams("plugins&m=msg_1"), { kind: "connections" }),
      ),
    ).toBe("?m=msg_1&connections");
    expect(shellOverlaySearch(new URLSearchParams("?integrations&m=msg_1"))).toBe("?connections");
  });

  it("writes a section back as the link that reopens it", () => {
    for (const section of ["agents", "skills", "apps", "connections"] as const) {
      const params = withShellOverlay(new URLSearchParams("m=msg_1"), storeOverlay(section));
      expect(storeSection(readShellOverlay(params))).toBe(section);
      expect(params.get("m")).toBe("msg_1");
    }
    expect(searchString(withShellOverlay(new URLSearchParams(), storeOverlay("apps")))).toBe(
      "?apps",
    );
  });
});
