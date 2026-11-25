/**
 * Draws the full-screen chat: agents, their conversations and waiting approvals on the left, the
 * open conversation and composer on the right, and one line of key hints.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { conversationLabel } from "../commands/threads.js";
import { terminalText, textLines } from "../output/text.js";
import type { App, Focus, Rgb } from "./state.js";
import { openAgent } from "./state.js";
import type { TranscriptLine } from "./transcript-lines.js";
import { transcriptLines, visibleLines } from "./transcript-lines.js";

const SIDEBAR = 30;
const DIM = "gray";

/** An identity colour as Ink takes it. */
export const hex = (color: Rgb | undefined) =>
  color && `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const firstLine = (text: string) => textLines(text)[0] ?? "";

const chars = (text: string) => [...text].length;

/** The visible part of `text` within `width` columns. */
const clip = (text: string, width: number) => [...text].slice(0, Math.max(width, 0)).join("");

/** A bordered panel with its title set into the top border. */
function Panel(props: {
  title: ReactNode;
  titleWidth: number;
  width: number;
  height: number;
  focused: boolean;
  children?: ReactNode;
}) {
  const { width, height, focused } = props;
  const border = focused ? undefined : DIM;
  const inner = Math.max(width - 2, 0);
  const rule = "─".repeat(Math.max(inner - props.titleWidth, 0));
  if (height <= 0 || width <= 0) return null;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={border}>┌</Text>
        {props.title}
        <Text color={border}>{`${rule}┐`}</Text>
      </Text>
      {height > 1 && (
        <Box
          borderStyle="single"
          borderTop={false}
          borderColor={border}
          width={width}
          height={height - 1}
          flexDirection="column"
          overflow="hidden"
        >
          {props.children}
        </Box>
      )}
    </Box>
  );
}

function List(props: {
  title: string;
  items: Array<{ key: string; content: ReactNode }>;
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}) {
  const { items, selected, focused, width, height } = props;
  const rows = Math.max(height - 2, 0);
  const offset = Math.max(0, Math.min(selected - rows + 1, items.length - rows));
  const shown = items.slice(Math.max(offset, 0), Math.max(offset, 0) + rows);
  return (
    <Panel
      title={<Text>{clip(props.title, width - 2)}</Text>}
      titleWidth={Math.min(chars(props.title), Math.max(width - 2, 0))}
      width={width}
      height={height}
      focused={focused}
    >
      {shown.map((item, index) => {
        const isSelected = index + Math.max(offset, 0) === selected;
        return (
          <Text
            key={item.key}
            wrap="truncate"
            inverse={isSelected && focused}
            bold={isSelected && !focused}
          >
            {item.content}
          </Text>
        );
      })}
    </Panel>
  );
}

const HINTS: Record<Focus, Array<[key: string, action: string]>> = {
  agents: [
    ["↑↓", "select"],
    ["enter", "open"],
    ["tab", "next"],
    ["q", "quit"],
  ],
  conversations: [
    ["↑↓", "select"],
    ["enter", "open"],
    ["n", "new"],
    ["tab", "next"],
    ["q", "quit"],
  ],
  composer: [
    ["enter", "send"],
    ["pgup/pgdn", "scroll"],
    ["tab", "next"],
    ["esc", "agents"],
    ["ctrl-c", "quit"],
  ],
  approvals: [
    ["↑↓", "select"],
    ["a", "allow"],
    ["d", "deny"],
    ["tab", "next"],
    ["q", "quit"],
  ],
};

function HintLine({ app, width }: { app: App; width: number }) {
  if (app.notice !== undefined) {
    return <Text wrap="truncate">{clip(firstLine(terminalText(app.notice)), width)}</Text>;
  }
  return (
    <Text wrap="truncate">
      {HINTS[app.focus].map(([key, action], index) => (
        <Text key={key}>
          {index > 0 ? "  " : ""}
          <Text bold>{key}</Text>
          <Text color={DIM}>{` ${action}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

function TranscriptRow({ line }: { line: TranscriptLine }) {
  return (
    <Text wrap="truncate" bold={line.name} color={line.dim ? DIM : hex(line.color)}>
      {line.text === "" ? " " : line.text}
    </Text>
  );
}

function Chat({ app, width, height }: { app: App; width: number; height: number }) {
  const agent = openAgent(app);
  const conversation = app.conversations[app.conversation];
  const label = conversation
    ? ` · ${firstLine(terminalText(conversationLabel(conversation)))}`
    : "";
  const name = agent ? terminalText(agent.name) : "";
  const titleWidth = chars(agent ? ` ${name}${label} ` : " ");
  const innerWidth = Math.max(width - 2, 1);
  const innerHeight = Math.max(height - 2, 0);
  const lines = transcriptLines(app, agent?.name ?? "", agent?.color, innerWidth);
  return (
    <Panel
      title={
        <Text>
          {" "}
          <Text color={hex(agent?.color)}>{name}</Text>
          {agent ? `${label} ` : ""}
        </Text>
      }
      titleWidth={titleWidth}
      width={width}
      height={height}
      focused={false}
    >
      {visibleLines(lines, innerHeight, app.scroll).map((line, index) => (
        <TranscriptRow key={index} line={line} />
      ))}
    </Panel>
  );
}

function Composer({ app, width }: { app: App; width: number }) {
  const focused = app.focus === "composer";
  const visible = Math.max(width - 3, 0);
  const text = [...terminalText(app.composer)];
  const shown = text.slice(Math.max(text.length - visible, 0)).join("");
  return (
    <Panel title="" titleWidth={0} width={width} height={3} focused={focused}>
      <Text wrap="truncate">
        {shown}
        {focused ? <Text inverse> </Text> : null}
      </Text>
    </Panel>
  );
}

/** The whole screen for a terminal of `width` by `height`. */
export function TuiView({ app, width, height }: { app: App; width: number; height: number }) {
  const main = Math.max(height - 1, 0);
  const sidebar = Math.min(SIDEBAR, Math.floor(width / 3));
  const right = Math.max(width - sidebar, 0);
  const approvals =
    app.approvals.length === 0 ? 0 : Math.min(app.approvals.length + 2, Math.floor(main / 3));
  const lists = Math.max(main - approvals, 0);
  const agentsHeight = Math.ceil(lists / 2);
  const transcriptHeight = Math.max(main - 3, 0);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" height={main}>
        <Box flexDirection="column" width={sidebar}>
          <List
            title=" Agents "
            items={app.agents.map((agent) => ({
              key: agent.id,
              content: <Text color={hex(agent.color)}>{terminalText(agent.name)}</Text>,
            }))}
            selected={app.agent}
            focused={app.focus === "agents"}
            width={sidebar}
            height={agentsHeight}
          />
          <List
            title=" Conversations "
            items={app.conversations.map((row) => ({
              key: row.threadId,
              content: firstLine(terminalText(conversationLabel(row))),
            }))}
            selected={app.conversation}
            focused={app.focus === "conversations"}
            width={sidebar}
            height={lists - agentsHeight}
          />
          {approvals > 0 && (
            <List
              title={` Approvals ${app.approvals.length} `}
              items={app.approvals.map((approval) => {
                const color = app.agents.find((agent) => agent.id === approval.agentId)?.color;
                // The question first, so a narrow sidebar cuts the agent's name instead.
                return {
                  key: approval.id,
                  content: (
                    <Text>
                      {firstLine(terminalText(approval.title))}{" "}
                      <Text color={hex(color)}>{terminalText(approval.agentName)}</Text>
                    </Text>
                  ),
                };
              })}
              selected={app.approval}
              focused={app.focus === "approvals"}
              width={sidebar}
              height={approvals}
            />
          )}
        </Box>
        <Box flexDirection="column" width={right}>
          <Chat app={app} width={right} height={transcriptHeight} />
          <Composer app={app} width={right} />
        </Box>
      </Box>
      <HintLine app={app} width={width} />
    </Box>
  );
}
