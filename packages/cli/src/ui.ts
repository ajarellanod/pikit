/**
 * Terminal input and output for the CLI. Prompts exist only on a terminal; every command that
 * asks something also takes its answer from a flag, so it can run in a script.
 */

import { createInterface } from "node:readline/promises";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Ctrl-C at a prompt: the command stops with 130, as a shell reports an interrupted command. */
export class Cancelled extends Error {}

export async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim();
  } catch (error) {
    // readline rejects the question with an AbortError on Ctrl-C.
    if (error instanceof Error && error.name === "AbortError") throw new Cancelled("cancelled");
    throw error;
  } finally {
    terminal.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}

/** A question whose Enter means yes. */
export async function confirmYes(question: string): Promise<boolean> {
  const answer = await ask(`${question} [Y/n] `);
  return answer === "" || /^y(es)?$/i.test(answer);
}

/** Reads a line without echoing it: for secrets. Ctrl-C aborts the command. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  // Echo off before the question shows: what is pasted the moment it appears is not echoed either.
  stdin.setRawMode(true);
  process.stdout.write(question);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Cancelled("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

export const log = {
  info: (message: string) => console.log(message),
  step: (message: string) => console.log(`→ ${message}`),
  ok: (message: string) => console.log(`✓ ${message}`),
  warn: (message: string) => console.warn(`! ${message}`),
  problem: (message: string) => console.error(`✗ ${message}`),
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
