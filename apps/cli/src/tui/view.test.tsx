import { deferred, flush } from "@rakazo/core/test-async";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tasks } from "./run.js";
import { keysFrom, reconnectWait, TuiApp } from "./run.js";
import type { Msg } from "./state.js";
import { receive } from "./state.js";
import { wrap } from "./transcript-lines.js";
import { app, bot, pending } from "./tui.test-support.js";
import { hex, TuiView } from "./view.js";

const plain = (frame: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes from the frame.
  (frame ?? "").replace(/\u001b\[[0-9;]*m/g, "");

function chatting() {
  const state = app();
  receive(state, {
    kind: "agents",
    bots: [bot("bot-1", "Fixture agent", "#3b82f6"), bot("bot-2", "Research", "#22c55e")],
  });
  receive(state, {
    kind: "conversations",
    agentId: "bot-1",
    rows: [{ threadId: "thread-1", first: true, title: null, preview: null }],
  });
  return state;
}

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

function screen(state: ReturnType<typeof app>, width: number, height: number) {
  const instance = render(<TuiView app={state} width={width} height={height} />);
  mounted.push(instance);
  const frame = instance.lastFrame();
  return { rows: plain(frame).split("\n"), raw: frame ?? "" };
}

describe("full-screen chat view", () => {
  it("lists agents in their colour and shows the key hints", () => {
    const state = chatting();
    state.focus = "agents";
    const { rows } = screen(state, 100, 20);
    expect(rows[0]).toContain("Agents");
    expect(rows.some((row) => row.includes("Fixture agent"))).toBe(true);
    expect(rows.some((row) => row.includes("Research"))).toBe(true);
    expect(rows.some((row) => row.includes("First conversation"))).toBe(true);
    expect(rows.at(-1)?.startsWith("↑↓ select  enter open  tab next  q quit")).toBe(true);
    expect(rows.some((row) => row.includes("Approvals"))).toBe(false);
    // Research is drawn in its identity colour.
    expect(hex(state.agents[1]?.color)).toBe("#22c55e");
  });

  it("draws the streaming reply under the agent with a caret", () => {
    const state = chatting();
    state.focus = "composer";
    state.composer = "next question";
    receive(state, {
      kind: "updates",
      generation: 1,
      updates: [{ kind: "draft", delta: "The fixture response" }],
    });
    const { rows } = screen(state, 100, 20);
    const text = rows.join("\n");
    expect(text).toContain("The fixture response▍");
    expect(text).toContain("next question");
    expect(rows.at(-1)?.startsWith("enter send")).toBe(true);
  });

  it("gives waiting approvals their own panel", () => {
    const state = chatting();
    receive(state, { kind: "approvals", found: [pending("message-1")] });
    const text = screen(state, 100, 24).rows.join("\n");
    expect(text).toContain("Approvals 1");
    expect(text).toContain("Allow web_fetch?");
  });

  it("replaces the hints with a failure and still draws in a narrow terminal", () => {
    const state = chatting();
    receive(state, { kind: "failed", reason: "Could not send the message." });
    expect(screen(state, 100, 20).rows.at(-1)?.startsWith("Could not send the message.")).toBe(
      true,
    );
    expect(() => screen(state, 20, 6)).not.toThrow();
  });

  it("wraps at spaces and splits long words", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("reads Ink's keys as the state's keys", () => {
    const none = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      pageDown: false,
      pageUp: false,
      home: false,
      end: false,
      return: false,
      escape: false,
      ctrl: false,
      shift: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      super: false,
      hyper: false,
      capsLock: false,
      numLock: false,
    };
    expect(keysFrom("", { ...none, tab: true, shift: true })).toEqual([{ code: "backTab" }]);
    expect(keysFrom("", { ...none, delete: true })).toEqual([{ code: "backspace" }]);
    expect(keysFrom("hi", none)).toEqual([
      { code: "char", char: "h", ctrl: false },
      { code: "char", char: "i", ctrl: false },
    ]);
    expect(reconnectWait(1)).toBe(500);
    expect(reconnectWait(9)).toBe(5_000);
  });
});

describe("full-screen chat app", () => {
  it("starts its reads, sends what is typed and quits on Ctrl+C", async () => {
    const state = app();
    const ran: string[] = [];
    let dispatch: ((message: Msg) => void) | undefined;
    const stopped = deferred();
    const createTasks = (send: (message: Msg) => void) => {
      dispatch = send;
      return {
        run: (_app: unknown, effect: { kind: string }) => ran.push(effect.kind),
        followSignals: () => ran.push("signals"),
        stop: () => stopped.resolve(),
      } as unknown as Tasks;
    };
    const instance = render(
      <TuiApp app={state} createTasks={createTasks} size={{ width: 100, height: 20 }} />,
    );
    mounted.push(instance);
    await vi.waitFor(() => expect(ran).toEqual(["signals", "loadAgents", "loadApprovals"]));
    dispatch?.({ kind: "agents", bots: [bot("bot-1", "Fixture agent", "#3b82f6")] });
    await vi.waitFor(() => expect(ran).toContain("follow"));
    instance.stdin.write("Hi");
    await vi.waitFor(() => expect(plain(instance.lastFrame())).toContain("Hi"));
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(ran).toContain("send"));
    expect(state.composer).toBe("");
    instance.stdin.write("\u0003");
    await vi.waitFor(() => expect(state.quit).toBe(true));
    await flush();
    await stopped.promise;
  });
});
