/**
 * What the full-screen chat shows and how keys and server answers change it. Pure: the runner
 * performs the effects this returns and feeds the results back as messages.
 */
import type { PendingApproval } from "../approvals/approvals.js";
import { messageText } from "../approvals/approvals.js";
import type { Update } from "../chat/reply.js";
import type { Conversation } from "../commands/threads.js";
import type { AgentRef, Catalog, SpaceRef } from "../session/catalog.js";
import type { Snapshot } from "../threads/thread-api.js";

export type Focus = "agents" | "conversations" | "composer" | "approvals";

export type Speaker = { kind: "member"; name: string } | { kind: "agent" } | { kind: "superbot" };

export type Entry = { id: string; speaker: Speaker; text: string };

export type Rgb = [red: number, green: number, blue: number];

export type AgentRow = {
  id: string;
  name: string;
  /** The bot's identity colour, the only colour on screen. */
  color: Rgb | undefined;
};

/** The conversation the chat pane shows. `threadId` is undefined for the agent's first one. */
export type OpenChat = { agentId: string; threadId: string | undefined };

export type Effect =
  | { kind: "loadAgents" }
  | { kind: "loadConversations"; agentId: string }
  /** Read the conversation, then follow its live events, tagged with `generation`. */
  | { kind: "follow"; chat: OpenChat; generation: number }
  | { kind: "send"; chat: OpenChat; text: string }
  | { kind: "newConversation"; agentId: string }
  | { kind: "answer"; approval: PendingApproval; answer: "allow" | "deny" }
  | { kind: "loadApprovals" };

/** A bot as the roster lists it. */
export type RosterBot = { id: string; name: string; color: string; archivedAt?: string | null };

export type Msg =
  | { kind: "agents"; bots: RosterBot[] }
  | { kind: "conversations"; agentId: string; rows: Conversation[] }
  | { kind: "snapshot"; generation: number; snapshot: Snapshot }
  | { kind: "updates"; generation: number; updates: Update[] }
  | { kind: "approvals"; found: PendingApproval[] }
  | { kind: "created"; agentId: string; threadId: string }
  | { kind: "answered" }
  /** The roster may have changed; read the agents again. */
  | { kind: "rosterChanged" }
  /** Runs may have changed; read the approvals again. */
  | { kind: "runsChanged" }
  | { kind: "failed"; reason: string };

/** A key press, named the way the reducer reads it. */
export type Key =
  | {
      code:
        | "tab"
        | "backTab"
        | "pageUp"
        | "pageDown"
        | "up"
        | "down"
        | "enter"
        | "esc"
        | "backspace";
      ctrl?: boolean;
    }
  | { code: "char"; char: string; ctrl?: boolean };

export type App = {
  space: SpaceRef;
  agents: AgentRow[];
  agent: number;
  conversations: Conversation[];
  conversation: number;
  open: OpenChat | undefined;
  generation: number;
  entries: Entry[];
  draft: string;
  activity: string | undefined;
  working: boolean;
  composer: string;
  /** Lines scrolled up from the newest message. */
  scroll: number;
  approvals: PendingApproval[];
  approval: number;
  focus: Focus;
  /** A failure to show until the next key. */
  notice: string | undefined;
  quit: boolean;
};

export function newApp(space: SpaceRef): App {
  return {
    space,
    agents: [],
    agent: 0,
    conversations: [],
    conversation: 0,
    open: undefined,
    generation: 0,
    entries: [],
    draft: "",
    activity: undefined,
    working: false,
    composer: "",
    scroll: 0,
    approvals: [],
    approval: 0,
    focus: "agents",
    notice: undefined,
    quit: false,
  };
}

export function start(): Effect[] {
  return [{ kind: "loadAgents" }, { kind: "loadApprovals" }];
}

export function openAgent(app: App): AgentRow | undefined {
  const open = app.open;
  return open && app.agents.find((agent) => agent.id === open.agentId);
}

/** The agents as the approvals scan reads them. */
export function catalogOf(app: App): Catalog {
  const agents: AgentRef[] = app.agents.map(({ id, name }) => ({ id, name }));
  return [{ space: app.space, agents }];
}

/** Which panels Tab cycles through: approvals only while some are waiting. */
function focusOrder(app: App): Focus[] {
  const order: Focus[] = ["agents", "conversations", "composer"];
  if (app.approvals.length > 0) order.push("approvals");
  return order;
}

function cycleFocus(app: App, step: number): void {
  const order = focusOrder(app);
  const at = Math.max(order.indexOf(app.focus), 0);
  app.focus = order[(((at + step) % order.length) + order.length) % order.length] ?? "agents";
}

function openChat(app: App, chat: OpenChat): Effect[] {
  app.generation += 1;
  app.entries = [];
  app.draft = "";
  app.activity = undefined;
  app.working = false;
  app.scroll = 0;
  app.open = { ...chat };
  return [{ kind: "follow", chat, generation: app.generation }];
}

function openSelectedAgent(app: App): Effect[] {
  const agent = app.agents[app.agent];
  if (!agent) return [];
  app.conversations = [];
  app.conversation = 0;
  return [
    ...openChat(app, { agentId: agent.id, threadId: undefined }),
    { kind: "loadConversations", agentId: agent.id },
  ];
}

function moveIn(index: number, length: number, key: Key): number {
  if (key.code === "up" || (key.code === "char" && key.char === "k")) return Math.max(index - 1, 0);
  if ((key.code === "down" || (key.code === "char" && key.char === "j")) && index + 1 < length) {
    return index + 1;
  }
  return index;
}

/** Keys every list shares: `q` quits, Esc goes to the composer. */
function listKey(app: App, key: Key, effects: Effect[]): Effect[] {
  if (key.code === "char" && key.char === "q") app.quit = true;
  else if (key.code === "esc") app.focus = "composer";
  return effects;
}

/** Applies a key press; the app is changed in place and the effects to run are returned. */
export function pressKey(app: App, key: Key): Effect[] {
  app.notice = undefined;
  if (key.ctrl && key.code === "char" && key.char === "c") {
    app.quit = true;
    return [];
  }
  switch (key.code) {
    case "tab":
      cycleFocus(app, 1);
      return [];
    case "backTab":
      cycleFocus(app, -1);
      return [];
    case "pageUp":
      app.scroll += 10;
      return [];
    case "pageDown":
      app.scroll = Math.max(app.scroll - 10, 0);
      return [];
  }
  switch (app.focus) {
    case "composer":
      return composerKey(app, key);
    case "agents": {
      let effects: Effect[] = [];
      if (key.code === "enter") {
        effects = openSelectedAgent(app);
        app.focus = "composer";
      }
      app.agent = moveIn(app.agent, app.agents.length, key);
      return listKey(app, key, effects);
    }
    case "conversations": {
      let effects: Effect[] = [];
      const open = app.open;
      if (key.code === "enter" && open) {
        const row = app.conversations[app.conversation];
        if (row) {
          app.focus = "composer";
          effects = openChat(app, {
            agentId: open.agentId,
            threadId: row.first ? undefined : row.threadId,
          });
        }
      } else if (key.code === "char" && key.char === "n" && open) {
        effects = [{ kind: "newConversation", agentId: open.agentId }];
      }
      app.conversation = moveIn(app.conversation, app.conversations.length, key);
      return listKey(app, key, effects);
    }
    case "approvals": {
      const answer =
        key.code === "char" && key.char === "a"
          ? "allow"
          : key.code === "char" && key.char === "d"
            ? "deny"
            : undefined;
      const approval = app.approvals[app.approval];
      const effects: Effect[] =
        answer && approval ? [{ kind: "answer", approval: { ...approval }, answer }] : [];
      app.approval = moveIn(app.approval, app.approvals.length, key);
      return listKey(app, key, effects);
    }
  }
}

function composerKey(app: App, key: Key): Effect[] {
  if (key.code === "esc") app.focus = "agents";
  else if (key.code === "backspace") app.composer = [...app.composer].slice(0, -1).join("");
  else if (key.code === "enter") {
    const text = app.composer.trim();
    const chat = app.open;
    if (!chat || text === "") return [];
    app.composer = "";
    app.scroll = 0;
    app.working = true;
    return [{ kind: "send", chat: { ...chat }, text }];
  } else if (key.code === "char" && !key.ctrl) {
    app.composer += key.char;
  }
  return [];
}

function speakerOf(role: string, author: { name: string } | null | undefined): Speaker {
  if (role === "user") return { kind: "member", name: author?.name ?? "Member" };
  if (role === "bot") return { kind: "agent" };
  return { kind: "superbot" };
}

/** Applies a server answer or signal; the app is changed in place and the effects returned. */
export function receive(app: App, message: Msg): Effect[] {
  switch (message.kind) {
    case "agents": {
      const selected = app.agents[app.agent]?.id;
      app.agents = message.bots
        .filter((bot) => !bot.archivedAt)
        .map((bot) => ({ id: bot.id, name: bot.name, color: identityColor(bot.color) }));
      const at =
        selected === undefined ? -1 : app.agents.findIndex((agent) => agent.id === selected);
      app.agent = at === -1 ? 0 : at;
      if (!app.open && app.agents.length > 0) {
        app.focus = "composer";
        return openSelectedAgent(app);
      }
      return [];
    }
    case "conversations": {
      const open = app.open;
      if (open?.agentId === message.agentId) {
        const at = message.rows.findIndex((row) =>
          open.threadId === undefined ? row.first : row.threadId === open.threadId,
        );
        app.conversation = at === -1 ? 0 : at;
        app.conversations = message.rows;
      }
      return [];
    }
    case "snapshot": {
      if (message.generation !== app.generation) return [];
      app.entries = message.snapshot.messages.flatMap((entry) => {
        const text = messageText(entry);
        return text.trim() === ""
          ? []
          : [{ id: entry.id, speaker: speakerOf(entry.role, entry.author), text }];
      });
      const status = message.snapshot.run?.status;
      app.working = status === "running" || status === "queued";
      return [];
    }
    case "updates":
      if (message.generation !== app.generation) return [];
      return message.updates.flatMap((update) => applyUpdate(app, update));
    case "approvals":
      app.approvals = message.found;
      app.approval = Math.min(app.approval, Math.max(app.approvals.length - 1, 0));
      if (app.approvals.length === 0 && app.focus === "approvals") app.focus = "composer";
      return [];
    case "created":
      if (app.open?.agentId !== message.agentId) return [];
      app.focus = "composer";
      return [
        ...openChat(app, { agentId: message.agentId, threadId: message.threadId }),
        { kind: "loadConversations", agentId: message.agentId },
      ];
    case "answered":
    case "runsChanged":
      return [{ kind: "loadApprovals" }];
    case "rosterChanged":
      return [{ kind: "loadAgents" }];
    case "failed":
      app.working = false;
      app.notice = message.reason;
      return [];
  }
}

function applyUpdate(app: App, update: Update): Effect[] {
  switch (update.kind) {
    case "draft":
      app.working = true;
      app.draft += update.delta;
      return [];
    case "draftWithdrawn":
      app.draft = "";
      return [];
    case "activity":
      if (update.text !== undefined) app.working = true;
      app.activity = update.text;
      return [];
    case "message": {
      const { message } = update;
      if (message.role === "bot" && message.text !== "") app.draft = "";
      if (message.text.trim() === "") return [];
      const entry: Entry = {
        id: message.id,
        speaker: speakerOf(message.role, message.author),
        text: message.text,
      };
      const known = app.entries.findIndex((existing) => existing.id === entry.id);
      if (known === -1) app.entries.push(entry);
      else app.entries[known] = entry;
      return [];
    }
    case "runEnded":
      app.working = false;
      app.draft = "";
      app.activity = undefined;
      if (update.end.kind === "failed") app.notice = `Agent run failed. ${update.end.reason}`;
      else if (update.end.kind === "waitingInput") return [{ kind: "loadApprovals" }];
      return [];
    case "cleared":
      app.entries = [];
      app.draft = "";
      return [];
  }
}

/** A bot colour value is `#rrggbb`, optionally followed by `::shape_NAME`. */
export function identityColor(value: string): Rgb | undefined {
  const hex = value.split("::")[0] ?? "";
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return undefined;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}
