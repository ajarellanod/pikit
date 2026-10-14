/**
 * The two questions `pikit expose` asks a person at a terminal: the API token, without echo, and a
 * yes or no. The command runs in a child of the CLI with the terminal inherited (`component-command.ts`).
 */

import { createInterface } from "node:readline/promises";

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** A line typed without echo: nothing shown but one dot per character. Ctrl-C ends the process. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  process.stdout.write(question);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      // A paste wrapped in bracketed-paste markers, or an arrow key: escape sequences are never the value.
      for (const char of chunk.replace(/\u001b\[[0-9;]*[@-~]/g, "")) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (char >= " ") {
          value += char;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Yes or no; Enter is no. */
export async function confirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await lines.question(`${question} [y/N] `)).trim());
  } finally {
    lines.close();
  }
}
