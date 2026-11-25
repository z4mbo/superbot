import { terminalText } from "../output/text.js";
import type { App, Rgb } from "./state.js";

/** One line of the chat pane. `name` lines are bold; `color` is an agent's identity colour. */
export type TranscriptLine = { text: string; name?: boolean; color?: Rgb; dim?: boolean };

/** Wraps at spaces to `width` columns, breaking words longer than a line. */
export function wrap(text: string, width: number): string[] {
  const columns = Math.max(width, 1);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let length = 0;
    for (const piece of paragraph.split(" ")) {
      let word = [...piece];
      const gap = length > 0 ? 1 : 0;
      if (length + gap + word.length > columns && length > 0) {
        lines.push(line);
        line = "";
        length = 0;
      } else if (gap === 1) {
        line += " ";
        length += 1;
      }
      while (word.length > columns) {
        lines.push(word.slice(0, columns).join(""));
        word = word.slice(columns);
      }
      length += word.length;
      line += word.join("");
    }
    lines.push(line);
  }
  return lines;
}

/** The conversation as wrapped lines: each message under its speaker, then the streaming reply. */
export function transcriptLines(
  app: App,
  agentName: string,
  agentColor: Rgb | undefined,
  width: number,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const push = (text: string, style: Omit<TranscriptLine, "text"> = {}) => {
    for (const row of wrap(terminalText(text), width)) lines.push({ text: row, ...style });
  };
  for (const entry of app.entries) {
    if (lines.length > 0) lines.push({ text: "" });
    if (entry.speaker.kind === "agent") {
      lines.push({ text: terminalText(agentName), name: true, color: agentColor });
    } else {
      const name = entry.speaker.kind === "member" ? entry.speaker.name : "Superbot";
      lines.push({ text: terminalText(name), name: true });
    }
    push(entry.text);
  }
  if (app.working || app.draft !== "") {
    if (lines.length > 0) lines.push({ text: "" });
    lines.push({ text: terminalText(agentName), name: true, color: agentColor });
    if (app.draft === "") push(app.activity ?? "Working…", { dim: true });
    else push(`${app.draft}▍`);
  }
  return lines;
}

/** The lines that fit `height`, scrolled `scroll` lines up from the newest. */
export function visibleLines<T>(lines: T[], height: number, scroll: number): T[] {
  const newest = Math.max(lines.length - height, 0);
  const top = Math.max(newest - scroll, 0);
  return lines.slice(top, top + height);
}
