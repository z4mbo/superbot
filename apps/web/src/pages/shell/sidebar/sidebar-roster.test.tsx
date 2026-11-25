// @vitest-environment jsdom
import type { Space } from "@rakazo/contracts";
import { CHIEF_BOT } from "@rakazo/contracts";
import { BotLookProvider } from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarRoster } from "./sidebar-roster";
import { sidebarGroupsForSpaces } from "./space-sidebar";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

type SpaceBot = Space["bots"][number];

function bot(id: string, name: string, extra: Partial<SpaceBot> = {}): SpaceBot {
  return {
    id,
    spaceId: "space-1",
    name,
    title: "",
    color: "#10B981",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    unread: false,
    parentBotId: null,
    preview: "",
    status: "idle",
    runErrorId: null,
    updatedAt: "2026-11-25T10:00:00.000Z",
    spawnKey: null,
    ...extra,
  };
}

const chief = bot("chief", CHIEF_BOT.name, {
  spawnKey: CHIEF_BOT.spawnKey,
  color: "#FFFFFF",
  lookShape: CHIEF_BOT.lookShape,
  lookColor: CHIEF_BOT.lookColor,
});
// A person's own bot that happens to carry the old first-run name, pinned by them.
const namesake = bot("namesake", "Chief", { pinned: true, color: "#F97316" });
const ada = bot("ada", "Ada");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(bots: SpaceBot[], others: Space[] = [], own: Partial<Space> = {}) {
  const space = {
    id: "space-1",
    name: "Personal",
    isDefault: true,
    hasContent: true,
    bots,
    groups: [],
    externalConversations: [],
    botSections: [],
    ...own,
  } as Space;
  const props: ComponentProps<typeof SidebarRoster> = {
    sidebarGroups: sidebarGroupsForSpaces([space, ...others], ""),
    collapsedSidebarSections: new Set(),
    bootstrapMe: { spaceId: "space-1" },
    botSections: [],
    spaces: [space, ...others],
    rosterDropKey: null,
    setRosterDropKey: vi.fn(),
    rosterDropAction: () => null,
    applyRosterDrop: vi.fn(),
    openSpaceChat: vi.fn(),
    spaceMenuAnchor: { current: null },
    setSpaceMenu: vi.fn(),
    setRenameSectionTarget: vi.fn(),
    setDeleteSectionTarget: vi.fn(),
    toggleSidebarSection: vi.fn(),
    inGroup: false,
    active: undefined,
    activeGroup: undefined,
    botsSidebarDensity: "comfortable",
    dismissedRunErrorIds: new Set(),
    displayedRunError: null,
    draggedBotId: null,
    setDraggedBotId: vi.fn(),
    chatMenu: { menu: null, setMenu: vi.fn(), content: null, has: () => true },
    reorderRosterBot: vi.fn(),
    activeSnapshot: null,
  };
  await act(async () =>
    root.render(
      <BotLookProvider bots={bots}>
        <SidebarRoster {...props} />
      </BotLookProvider>,
    ),
  );
  return props;
}

const tiles = () => [
  ...host.querySelectorAll<HTMLElement>('[data-sidebar-group="pinned"] [data-roster-bot-id]'),
];

it("pins the main bot first as a tile for every member, ahead of their own pins", async () => {
  // Never pinned by anyone: the main bot is always first among the tiles.
  await render([ada, namesake, chief]);
  expect(tiles().map((tile) => tile.dataset.rosterBotId)).toEqual(["chief", "namesake"]);
  expect(tiles()[0]?.querySelector("[data-roster-bot-name]")?.textContent).toBe(CHIEF_BOT.name);
  // Everyone else keeps their place below.
  const rows = [...host.querySelectorAll<HTMLElement>("[data-roster-bot-id]")];
  expect(rows.map((row) => row.dataset.rosterBotId)).toEqual(["chief", "namesake", "ada"]);
});

it("gives only the main bot the star, and draws it as the product's mark at 60px", async () => {
  await render([ada, namesake, chief]);
  const [main, own] = tiles();
  expect(main?.querySelectorAll(".lucide-star")).toHaveLength(1);
  expect(own?.querySelectorAll(".lucide-star")).toHaveLength(0);
  expect(host.querySelectorAll(".lucide-star")).toHaveLength(1);

  const mark = main?.querySelector<SVGSVGElement>("svg[data-bot-mark]");
  expect(mark?.dataset.botMark).toBe("blob");
  expect(mark?.dataset.botMarkInk).toBe("neutral");
  expect(mark?.style.width).toBe("60px");
  // The person's own bot named like the old main bot keeps its own colour.
  const ownMark = own?.querySelector<SVGSVGElement>("svg[data-bot-mark]");
  expect(ownMark?.dataset.botMarkInk).not.toBe("neutral");
});

it("lets each tile and row turn only its own bot's mark toward the pointer", async () => {
  await render([ada, namesake, chief]);
  for (const box of host.querySelectorAll<HTMLElement>("[data-roster-bot-id]")) {
    expect(box.dataset.botMarkHost).toBe(box.dataset.rosterBotId);
    expect(box.querySelectorAll("svg[data-bot-mark]")).toHaveLength(1);
  }
});

it("shows no tiles when there is no main bot and nothing is pinned", async () => {
  await render([ada, bot("bo", "Bo")]);
  expect(tiles()).toEqual([]);
  expect(host.querySelectorAll(".lucide-star")).toHaveLength(0);
});

it("names each Space above its tiles when several Spaces are listed", async () => {
  const projects = {
    id: "space-2",
    name: "Projects",
    isDefault: false,
    hasContent: true,
    bots: [bot("chief-2", CHIEF_BOT.name, { spaceId: "space-2", spawnKey: CHIEF_BOT.spawnKey })],
    groups: [],
    externalConversations: [],
    botSections: [],
  } as Space;
  await render([ada, chief], [projects]);
  const pinned = [...host.querySelectorAll<HTMLElement>('[data-sidebar-group$="pinned"]')];
  expect(pinned.map((group) => group.querySelector("[data-pinned-space]")?.textContent)).toEqual([
    "Personal",
    "Projects",
  ]);
  expect(host.querySelectorAll(".lucide-star")).toHaveLength(2);
});

/** Opens the Space menu from its actions button, and reports the Space it opened for. */
async function openSpaceActions(name: string, setSpaceMenu: ReturnType<typeof vi.fn>) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  return setSpaceMenu.mock.calls.at(-1)?.[0]?.id;
}

it.each([
  ["holds only its main bot", [chief]],
  ["holds its main bot and other bots", [ada, chief]],
  ["also holds a person's own pin", [ada, namesake, chief]],
])("keeps the Space's actions reachable when the Space %s", async (_state, bots) => {
  const { setSpaceMenu } = await render(bots);
  // The tiles come first, so they carry the Space's name and its one actions button.
  const heading = host.querySelector('[data-sidebar-group="pinned"] [data-pinned-space-heading]');
  expect(heading?.textContent).toContain("Personal");
  expect(host.querySelectorAll('button[aria-label="Actions for Personal"]')).toHaveLength(1);
  expect(await openSpaceActions("Personal", setSpaceMenu as ReturnType<typeof vi.fn>)).toBe(
    "space-1",
  );
});

it("keeps every Space's actions reachable for an invitee who sees several Spaces", async () => {
  const home = {
    id: "space-2",
    name: "Home",
    isDefault: false,
    hasContent: true,
    shared: true,
    canRename: false,
    canDelete: false,
    bots: [bot("chief-2", CHIEF_BOT.name, { spaceId: "space-2", spawnKey: CHIEF_BOT.spawnKey })],
    groups: [],
    externalConversations: [],
    botSections: [],
  } as Space;
  const { setSpaceMenu } = await render([ada, chief], [{ ...home, hasGuests: true }]);
  const spy = setSpaceMenu as ReturnType<typeof vi.fn>;
  // Someone from outside is marked on the heading, for screen readers too.
  const homeHeading = [...host.querySelectorAll("[data-pinned-space-heading]")].find((heading) =>
    heading.textContent?.includes("Home"),
  );
  expect(homeHeading?.querySelector(".lucide-globe")).not.toBeNull();
  expect(homeHeading?.textContent).toContain("Shared with guests");
  expect(await openSpaceActions("Personal", spy)).toBe("space-1");
  expect(await openSpaceActions("Home", spy)).toBe("space-2");
});
