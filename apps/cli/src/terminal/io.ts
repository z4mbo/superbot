/**
 * The command's terminal: what it prints and what it reads. Commands take one so tests can script
 * the input and read the output without a real terminal.
 */
export interface Io {
  /** Writes to standard output as given. */
  out(text: string): void;
  /** Writes to standard error as given. */
  err(text: string): void;
  readonly stdinIsTerminal: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly stderrIsTerminal: boolean;
  /** Prints `label` and reads one line without its line break; null at the end of input. */
  prompt(label: string): Promise<string | null>;
  /** Prints `label` and reads one line without echoing it. */
  secret(label: string): Promise<string>;
  /** Everything left on standard input. */
  readAll(): Promise<string>;
}

/** Writes a line to standard output, as `println!` did. */
export function line(io: Io, text = ""): void {
  io.out(`${text}\n`);
}

/** Writes a line to standard error, as `eprintln!` did. */
export function errorLine(io: Io, text = ""): void {
  io.err(`${text}\n`);
}
