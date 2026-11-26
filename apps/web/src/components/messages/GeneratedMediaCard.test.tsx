// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { GeneratedMediaDetails, MediaGenerationCard } from "./GeneratedMediaCard";

const media = {
  kind: "video" as const,
  prompt: "Waves on the shore",
  provider: "provider-id",
  providerName: "Provider Name",
  model: "video-model",
};

function card(status: "pending" | "completed" | "failed") {
  return {
    kind: "media_generation",
    jobId: "job-1",
    status,
    media,
  } satisfies Extract<MessageBlock, { kind: "media_generation" }>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

it("shows a generated item's prompt with the provider's display name and model", async () => {
  await render(<GeneratedMediaDetails media={media} />);
  expect(host.textContent).toBe("Waves on the shoreProvider Name · video-model");
});

it("leaves the model out when the provider chose its own", async () => {
  const { model: _model, ...withoutModel } = media;
  await render(<GeneratedMediaDetails media={withoutModel} />);
  expect(host.textContent).toBe("Waves on the shoreProvider Name");
});

it("shows a video being made as in progress, with what was asked", async () => {
  await render(<MediaGenerationCard block={card("pending")} startedAt={Date.now()} />);
  const shown = host.querySelector('[data-testid="media-generation-card"]');
  expect(shown?.textContent).toContain("Making the video");
  expect(shown?.textContent).toContain("Waves on the shore");
  expect(shown?.querySelector('[role="alert"]')).toBeNull();
});

it("says plainly that a video could not be made", async () => {
  await render(<MediaGenerationCard block={card("failed")} />);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Couldn't make the video");
  expect(host.textContent).not.toContain("Making the video");
  expect(host.textContent).toContain("Provider Name · video-model");
});

it("draws nothing once the video is done, since it arrives as its own message", async () => {
  await render(<MediaGenerationCard block={card("completed")} />);
  expect(host.innerHTML).toBe("");
});
