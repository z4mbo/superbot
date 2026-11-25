import { terminalText } from "../output/text.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";
import { speaker } from "./reply.js";

/** One message as a transcript line, `Name > text`; messages without text are left out. */
export function printMessage(
  io: Io,
  agentName: string,
  role: string,
  author: { name: string } | null | undefined,
  text: string,
): void {
  if (text.trim() === "") return;
  line(io, `${terminalText(speaker(agentName, role, author))} > ${terminalText(text)}`);
}
