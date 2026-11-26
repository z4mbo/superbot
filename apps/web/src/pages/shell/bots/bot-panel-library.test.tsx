// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  pages: [] as {
    items: {
      id: string;
      name: string;
      mimeType: string;
      generated?: {
        kind: "image" | "video";
        prompt: string;
        provider: string;
        providerName: string;
      };
    }[];
  }[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  isPending: false,
  isError: false,
}));
const navigate = vi.hoisted(() => vi.fn());
const listInput = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    artifacts: {
      listSpace: {
        infiniteOptions: (options: { input: (cursor: undefined) => unknown }) => {
          listInput(options.input(undefined));
          return {};
        },
      },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => ({
    data: { pages: files.pages },
    hasNextPage: files.hasNextPage,
    fetchNextPage: files.fetchNextPage,
    isPending: files.isPending,
    isError: files.isError,
    isFetchingNextPage: false,
  }),
}));
vi.mock("../../../components/pages/PagesList", () => ({
  PAGES_PREVIEW_COUNT: 5,
  PagesList: ({ botId, preview }: { botId: string; preview: { onOpenAll: () => void } }) => (
    <button type="button" data-testid="pages" data-bot={botId} onClick={preview.onOpenAll}>
      Pages
    </button>
  ),
}));

import { BotPanelLibrary } from "./bot-panel-library";

let container: HTMLDivElement;
let root: Root;
const onOpenPages = vi.fn();

function file(index: number, mimeType = "text/plain") {
  return { id: `file-${index}`, name: `Report ${index}`, mimeType };
}

async function render() {
  await act(async () =>
    root.render(<BotPanelLibrary bot={{ id: "bot-1", name: "Ada" }} onOpenPages={onOpenPages} />),
  );
}

function fileRows() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="bot-panel-files"] li button'),
  ];
}

function showMore() {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Show more",
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  files.pages = [];
  files.hasNextPage = false;
  files.isPending = false;
  files.isError = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows the bot's pages as private to you, then its files", async () => {
  await render();
  expect(
    [...container.querySelectorAll("section h3")].map((heading) => heading.textContent),
  ).toEqual(["Private to you", "Ada’s files"]);
  const pages = container.querySelector<HTMLButtonElement>('[data-testid="pages"]')!;
  expect(pages.dataset.bot).toBe("bot-1");
  await act(async () => pages.click());
  expect(onOpenPages).toHaveBeenCalledOnce();
  // Only the files the bot made, not the ones people uploaded.
  expect(listInput).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-1", madeByBots: true }),
  );
});

it("says so when the bot has no files yet", async () => {
  await render();
  expect(container.querySelector('[data-testid="bot-panel-files"]')?.textContent).toContain(
    "No files yet",
  );
  expect(showMore()).toBeUndefined();
});

it("lists five files, then the rest from Show more", async () => {
  files.pages = [{ items: [1, 2, 3, 4, 5, 6, 7].map((index) => file(index)) }];
  await render();
  expect(fileRows().map((row) => row.textContent)).toEqual(
    [1, 2, 3, 4, 5].map((index) => `Report ${index}`),
  );
  await act(async () => showMore()!.click());
  expect(fileRows()).toHaveLength(7);
  expect(files.fetchNextPage).not.toHaveBeenCalled();
  expect(showMore()).toBeUndefined();
});

it("reads the next page from Show more once every loaded file shows", async () => {
  files.pages = [{ items: [1, 2].map((index) => file(index)) }];
  files.hasNextPage = true;
  await render();
  await act(async () => showMore()!.click());
  expect(files.fetchNextPage).toHaveBeenCalledOnce();
});

it("opens a file from its row", async () => {
  files.pages = [{ items: [file(1, "image/png")] }];
  await render();
  await act(async () => fileRows()[0]!.click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/app/artifacts/file-1");
});

it("says a failed read instead of showing an empty list", async () => {
  files.isError = true;
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load files.");
});

it("names a generated file by what was asked for and the provider that made it", async () => {
  files.pages = [
    {
      items: [
        {
          ...file(1, "image/png"),
          name: "generated-abc123.png",
          generated: {
            kind: "image" as const,
            prompt: "A lighthouse at dusk",
            provider: "provider-id",
            providerName: "Provider Name",
          },
        },
        file(2),
      ],
    },
  ];
  await render();
  const [generated, plain] = fileRows();
  expect(generated?.textContent).toBe("A lighthouse at duskGenerated with Provider Name");
  expect(generated?.textContent).not.toContain("generated-abc123");
  expect(plain?.textContent).toBe("Report 2");
});
