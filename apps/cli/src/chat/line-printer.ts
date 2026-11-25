import { terminalText } from "../output/text.js";
import type { Update } from "./reply.js";
import { speaker } from "./reply.js";

/** Receives the updates a followed reply produces. */
export interface Sink {
  update(update: Update): void;
}

/** Writes updates as transcript lines, streaming the agent's draft in place on its line. */
export class LinePrinter implements Sink {
  readonly #out: (text: string) => void;
  readonly #err: (text: string) => void;
  readonly #agentName: string;
  /** `send` prints only the reply; the chat names each speaker. */
  readonly #named: boolean;
  #shown = "";
  failed = false;

  constructor(
    out: (text: string) => void,
    err: (text: string) => void,
    agentName: string,
    named: boolean,
  ) {
    this.#out = out;
    this.#err = err;
    this.#agentName = agentName;
    this.#named = named;
  }

  update(update: Update): void {
    switch (update.kind) {
      case "draft":
        if (this.#shown === "" && this.#named) this.#out(`${terminalText(this.#agentName)} > `);
        this.#out(terminalText(update.delta));
        this.#shown += update.delta;
        return;
      case "draftWithdrawn":
      case "cleared":
        this.#endLine();
        return;
      case "activity":
        return;
      case "message": {
        const { message } = update;
        if (message.role === "bot" && this.#shown !== "" && message.text.startsWith(this.#shown)) {
          this.#out(`${terminalText(message.text.slice(this.#shown.length))}\n`);
          this.#shown = "";
          return;
        }
        this.#endLine();
        if (message.text.trim() === "" || (!this.#named && message.role !== "bot")) return;
        if (this.#named) {
          const name = speaker(this.#agentName, message.role, message.author);
          this.#out(`${terminalText(name)} > `);
        }
        this.#out(`${terminalText(message.text)}\n`);
        return;
      }
      case "runEnded":
        this.#endLine();
        if (update.end.kind === "failed") {
          this.failed = true;
          this.#err(`Agent run failed. ${terminalText(update.end.reason)}\n`);
        } else if (update.end.kind === "cancelled") {
          this.failed = true;
          this.#err("Agent run cancelled.\n");
        }
        return;
    }
  }

  #endLine(): void {
    if (this.#shown !== "") {
      this.#out("\n");
      this.#shown = "";
    }
  }
}
