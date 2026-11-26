// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, VoiceStatus } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/query/rpc", () => {
  const rpc = {
    bots: { update: vi.fn(), list: vi.fn(async () => []) },
    voice: { status: vi.fn(), voices: vi.fn(async () => [{ id: "eve", label: "Eve" }]) },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
// Each option is a button, so a pick needs no popup.
vi.mock("@rakazo/ui-web", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  OptionSelect: ({
    id,
    value,
    options,
    onValueChange,
  }: {
    id: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <div id={id} data-value={value}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onValueChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

const { rpc } = await import("../../../lib/query/rpc");
const { BotPanelVoiceChat } = await import("./bot-panel-voice-chat");

const bot = { id: "bot-1", voiceId: null, voiceLanguage: null } as unknown as Bot;
const status = (patch: Partial<VoiceStatus>): VoiceStatus => ({
  configured: true,
  ready: true,
  transcribe: true,
  provider: "fake-voice",
  voiceId: "eve",
  dictation: true,
  live: { engine: "cascaded", turnModes: ["push-to-talk", "open-mic"] },
  ...patch,
});

describe("BotPanelVoiceChat", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const onVoiceIdChange = vi.fn();
  function render(onSaved = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <BotPanelVoiceChat
            bot={bot}
            voiceId=""
            onVoiceIdChange={onVoiceIdChange}
            onSaved={onSaved}
          />
        </QueryClientProvider>,
      ),
    );
    return onSaved;
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);

  it("stays hidden when nothing voice-capable is connected", async () => {
    vi.mocked(rpc.voice.status).mockResolvedValue(status({ dictation: false, live: null }));
    render();
    await vi.waitFor(() => expect(rpc.voice.status).toHaveBeenCalled());
    await act(async () => {});
    expect(container.querySelector('[data-testid="bot-voice-chat"]')).toBeNull();
  });

  it("offers the bot's voice and language, saving the language to the bot and the voice through the panel", async () => {
    vi.mocked(rpc.voice.status).mockResolvedValue(status({}));
    const saved = { ...bot, voiceLanguage: "pt-BR" };
    vi.mocked(rpc.bots.update).mockResolvedValue(saved as never);
    const onSaved = render();

    await vi.waitFor(() => expect(button("Eve")).toBeDefined());
    expect(container.textContent).toContain("Voice chat");
    expect(button("Auto-detect")).toBeDefined();
    const portuguese = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith("Brazilian Portuguese"),
    );
    act(() => portuguese!.click());
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(rpc.bots.update).toHaveBeenCalledWith({ botId: "bot-1", voiceLanguage: "pt-BR" });

    act(() => button("Eve")!.click());
    expect(onVoiceIdChange).toHaveBeenCalledWith("eve");
    expect(rpc.bots.update).toHaveBeenCalledTimes(1);
  });

  it("shows the language alone for dictation without a voice to speak with", async () => {
    vi.mocked(rpc.voice.status).mockResolvedValue(status({ ready: false, live: null }));
    render();
    await vi.waitFor(() => expect(button("Auto-detect")).toBeDefined());
    expect(rpc.voice.voices).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Account default");
  });
});
