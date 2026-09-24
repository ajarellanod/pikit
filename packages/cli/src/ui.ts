/**
 * Terminal input and output for the CLI. Prompts exist only on a terminal; every command that
 * asks something also takes its answer from a flag, so it can run in a script.
 */

import * as clack from "@clack/prompts";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Ctrl-C at a prompt: the command stops with 130, as a shell reports an interrupted command. */
export class Cancelled extends Error {}

/** A prompt's answer, or `Cancelled` when the person pressed Ctrl-C (or Esc). */
function answered<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new Cancelled("cancelled");
  return value as Exclude<T, symbol>;
}

export interface AskOptions {
  /** What Enter gives on an empty answer; shown as the placeholder. */
  defaultValue?: string;
  /** A message when the answer is not acceptable; the prompt stays until it is. */
  validate?: (answer: string) => string | undefined;
}

/** A line of text, trimmed. */
export async function ask(message: string, options: AskOptions = {}): Promise<string> {
  const { defaultValue, validate } = options;
  const answer = answered(
    await clack.text({
      message,
      ...(defaultValue !== undefined && { defaultValue, placeholder: defaultValue }),
      ...(validate !== undefined && { validate: (value: string | undefined) => validate((value ?? "").trim() || (defaultValue ?? "")) }),
    }),
  );
  return (answer ?? "").trim();
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Shown next to the option while it is selected. */
  hint?: string;
}

/** One of `choices`, picked with the arrow keys and Enter. */
export async function choose<T extends string>(message: string, choices: Choice<T>[], initialValue?: T): Promise<T> {
  const options = choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint !== undefined && { hint: c.hint }) }));
  return answered(await clack.select<T>({ message, options: options as Parameters<typeof clack.select<T>>[0]["options"], ...(initialValue !== undefined && { initialValue }) }));
}

/** Yes or no; Enter gives `initialValue`. */
export async function confirm(message: string, initialValue = false): Promise<boolean> {
  return answered(await clack.confirm({ message, initialValue }));
}

/** The start and the end of a guided path. */
export const intro = (title: string): void => clack.intro(title);
export const outro = (message: string): void => clack.outro(message);

/** A spinner for a long step; `stop` with what was done. */
export function spinner(message: string): { stop(done: string): void; error(message: string): void } {
  const s = clack.spinner();
  s.start(message);
  return { stop: (done) => s.stop(done), error: (failed) => s.error(failed) };
}

const CYAN = (text: string) => `\u001b[36m${text}\u001b[39m`;
const GRAY = (text: string) => `\u001b[90m${text}\u001b[39m`;

/**
 * Reads a secret, shown as one ▪ per character: for tokens and keys. Ctrl-C aborts the command.
 *
 * Not clack's `password`: a paste over several lines (BotFather's whole message) must stay one
 * answer, and clack keeps only its last line. It is drawn like clack's prompts.
 */
export function askSecret(message: string): Promise<string> {
  const stdin = process.stdin;
  // Echo off before the question shows: what is pasted the moment it appears is not echoed either.
  stdin.setRawMode(true);
  process.stdout.write(`${GRAY("│")}\n${CYAN("◆")}  ${message.replace(/:\s*$/, "")}\n${CYAN("│")}  `);
  let shown = 0;
  const mask = (length: number) => {
    // At most one line of dots: a long paste does not wrap the terminal.
    const target = Math.min(length, 48);
    if (target > shown) process.stdout.write("▪".repeat(target - shown));
    else if (target < shown) process.stdout.write("\b \b".repeat(shown - target));
    shown = target;
  };
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    // A terminal's escape sequences (ESC [ params final-byte) are never part of the value: arrow keys,
    // and the bracketed-paste markers ESC[200~ … ESC[201~ some terminals put around a paste.
    let escape: "" | "esc" | "csi" = "";
    let params = "";
    let pasting = false;
    const done = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i] as string;
        if (escape === "esc") {
          escape = char === "[" ? "csi" : "";
          params = "";
          continue;
        }
        if (escape === "csi") {
          if (char >= "@" && char <= "~") {
            escape = "";
            if (char === "~" && params === "200") pasting = true;
            if (char === "~" && params === "201") pasting = false;
          } else params += char;
          continue;
        }
        if (char === "\u001b") {
          escape = "esc";
          continue;
        }
        if (char === "\r" || char === "\n") {
          mask(value.length);
          // Enter ends the value. A line break inside pasted text does not: a paste arrives in one
          // chunk (or between the markers), so more text after it in the chunk means a paste.
          const rest = chars.slice(i + 1).join("").replace(/\u001b\[201~/g, "");
          if (pasting || /[^\r\n]/.test(rest)) {
            value += " ";
            continue;
          }
          return done();
        }
        if (char === "\u0003") return done(new Cancelled("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
      mask(value.length);
    };
    stdin.on("data", onData);
  });
}

/**
 * Set by the guided path (`pikit new`, `pikit configure` at a terminal) for its own process and the
 * steps it runs in child processes: lines are drawn on clack's rail, between its prompts.
 */
export const GUIDED = "PIKIT_GUIDED";

export function beginGuided(): void {
  process.env[GUIDED] = "1";
}

/** Each line after the rail, when a person is following a guided path on this stream. */
function railed(stream: NodeJS.WriteStream, text: string): string {
  if (process.env[GUIDED] !== "1" || stream.isTTY !== true) return text;
  return text
    .split("\n")
    .map((line) => `${GRAY("│")}${line === "" ? "" : `  ${line}`}`)
    .join("\n");
}

export const log = {
  info: (message: string) => console.log(railed(process.stdout, message)),
  step: (message: string) => console.log(railed(process.stdout, `→ ${message}`)),
  ok: (message: string) => console.log(railed(process.stdout, `✓ ${message}`)),
  warn: (message: string) => console.warn(railed(process.stderr, `! ${message}`)),
  problem: (message: string) => console.error(railed(process.stderr, `✗ ${message}`)),
};

/** An error the user can act on: printed without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
