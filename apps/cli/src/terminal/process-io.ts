import { Exit } from "../output/errors.js";
import type { Io } from "./io.js";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);

/**
 * Reads standard input on demand: lines for prompts, characters for hidden input, or the rest for
 * piped messages. Input arriving before it is asked for waits in a buffer, so prompts read piped
 * input in order. The stream is paused between reads so it never keeps the process running.
 */
export class StdinReader {
  readonly #stream: NodeJS.ReadStream;
  #buffer = "";
  #ended = false;
  #listening = false;
  #wake: (() => void) | undefined;

  constructor(stream: NodeJS.ReadStream) {
    this.#stream = stream;
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end !== -1) {
        const text = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        return text.replace(/[\r\n]+$/, "");
      }
      if (!(await this.#more())) {
        if (this.#buffer === "") return null;
        const rest = this.#buffer.replace(/[\r\n]+$/, "");
        this.#buffer = "";
        return rest;
      }
    }
  }

  async readAll(): Promise<string> {
    while (await this.#more()) {
      // Keep reading until the input ends.
    }
    const all = this.#buffer;
    this.#buffer = "";
    return all;
  }

  /** One line typed without echo. Ctrl+C ends the command as an interrupt. */
  async readHidden(): Promise<string> {
    const terminal = this.#stream.isTTY === true;
    if (terminal) this.#stream.setRawMode(true);
    let typed = "";
    try {
      for (;;) {
        if (this.#buffer === "" && !(await this.#more())) return typed;
        const char = this.#buffer[0] ?? "";
        this.#buffer = this.#buffer.slice(1);
        if (char === "\r" || char === "\n") {
          if (char === "\r" && this.#buffer.startsWith("\n")) this.#buffer = this.#buffer.slice(1);
          return typed;
        }
        if (terminal && char === CTRL_C) throw new Exit(130);
        if (terminal && char === CTRL_D && typed === "") return typed;
        if (BACKSPACE.has(char)) typed = [...typed].slice(0, -1).join("");
        else typed += char;
      }
    } finally {
      if (terminal) this.#stream.setRawMode(false);
    }
  }

  /** Waits for more input; false once it has ended. */
  async #more(): Promise<boolean> {
    if (this.#ended) return false;
    if (!this.#listening) {
      this.#listening = true;
      this.#stream.setEncoding("utf8");
      this.#stream.on("data", (chunk: string) => {
        this.#buffer += chunk;
        this.#wake?.();
      });
      const finish = () => {
        this.#ended = true;
        this.#wake?.();
      };
      this.#stream.on("end", finish);
      this.#stream.on("error", finish);
    }
    const arrived = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    this.#stream.resume();
    await arrived;
    this.#wake = undefined;
    this.#stream.pause();
    return true;
  }
}

/** The real terminal: this process's standard streams. */
export function processIo(): Io {
  const reader = new StdinReader(process.stdin);
  const out = (text: string) => {
    process.stdout.write(text);
  };
  const err = (text: string) => {
    process.stderr.write(text);
  };
  return {
    out,
    err,
    stdinIsTerminal: process.stdin.isTTY === true,
    stdoutIsTerminal: process.stdout.isTTY === true,
    stderrIsTerminal: process.stderr.isTTY === true,
    async prompt(label) {
      out(label);
      return reader.readLine();
    },
    async secret(label) {
      err(label);
      const typed = await reader.readHidden();
      if (process.stdin.isTTY) err("\n");
      return typed;
    },
    readAll: () => reader.readAll(),
  };
}
