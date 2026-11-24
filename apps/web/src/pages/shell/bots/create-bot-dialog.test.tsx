// @vitest-environment jsdom

import { botMarkShapeFor } from "@rakazo/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateBotDialogInput } from "./create-bot-dialog";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { PICKER_INKS, PICKER_SHAPES } from "./bot-look-picker";
import { CreateBotDialog } from "./create-bot-dialog";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onCreate: (input: CreateBotDialogInput) => Promise<void>) {
  await act(async () => {
    root.render(<CreateBotDialog onCancel={() => undefined} onCreate={onCreate} />);
  });
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("CreateBotDialog", () => {
  it("creates only once the name is not blank", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(onCreate);
    expect(button("Create").disabled).toBe(true);
    await typeName("   ");
    expect(button("Create").disabled).toBe(true);
    await typeName("  Scout  ");
    expect(button("Create").disabled).toBe(false);
  });

  it("offers the reference's bodies in rows of five and its eleven colours", async () => {
    await render(vi.fn(async () => undefined));
    const shapes = [...document.querySelectorAll("[data-bot-look-shape]")].map((cell) =>
      cell.getAttribute("data-bot-look-shape"),
    );
    // The picker's thirteen, plus the starting body when it is one the picker does not offer.
    expect(shapes.slice(0, PICKER_SHAPES.length)).toEqual(PICKER_SHAPES);
    expect(shapes.length - PICKER_SHAPES.length).toBeLessThanOrEqual(1);
    const rows = document.querySelector('[aria-label="Character shape"]')!.children;
    // A starting body the picker does not offer joins the last row.
    expect([...rows].map((row) => row.children.length)).toEqual([5, 5, shapes.length - 10]);
    expect(
      [...document.querySelectorAll("[data-bot-look-ink]")].map((cell) =>
        cell.getAttribute("data-bot-look-ink"),
      ),
    ).toEqual(PICKER_INKS);
  });

  it("sends the picked body and ink as the new bot's look, with the ink's colour", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("cloud character shape"));
    await click(button("Green character color"));
    expect(button("cloud character shape").getAttribute("aria-pressed")).toBe("true");
    expect(button("Green character color").getAttribute("aria-pressed")).toBe("true");
    await typeName("Scout");
    await click(button("Create"));
    const input = onCreate.mock.lastCall![0];
    expect(input).toMatchObject({
      name: "Scout",
      lookShape: "cloud",
      lookColor: "green",
      color: "#14C16F",
    });
    expect(input.id).toMatch(/^c[a-z0-9]{24}$/);
  });

  it("starts on an everyday body in a colour other than black", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await typeName("Scout");
    await click(button("Create"));
    const input = onCreate.mock.lastCall![0];
    expect(input.lookShape).toBe(botMarkShapeFor(input.id!));
    expect(input.lookColor).not.toBe("neutral");
  });

  it("keeps the picked look through a failed create and retry", async () => {
    const onCreate = vi
      .fn(async (_input: CreateBotDialogInput) => undefined)
      .mockRejectedValueOnce(new Error("Try again"));
    await render(onCreate);
    await click(button("star character shape"));
    await click(button("Violet character color"));
    await typeName("Scout");
    await click(button("Create"));
    const first = onCreate.mock.lastCall![0];
    await click(button("Create"));
    const second = onCreate.mock.lastCall![0];
    expect(second).toMatchObject({ lookShape: "star", lookColor: "purple" });
    expect(second.id).toBe(first.id);
  });

  it("shows the error and stays open when creating fails", async () => {
    await render(async () => {
      throw new Error("Bot limit reached");
    });
    await typeName("Scout");
    await click(button("Create"));
    expect(document.querySelector('[data-testid="create-bot-error"]')?.textContent).toBe(
      "Bot limit reached",
    );
    expect(document.querySelector('[data-testid="create-bot-dialog"]')).not.toBeNull();
  });
});

/** Saves need a query client; each root gets its own. */
function createRoot(container: Element) {
  const root = createReactRoot(container);
  const queryClient = new QueryClient();
  return {
    render: (node: ReactNode) =>
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
    unmount: () => root.unmount(),
  };
}
