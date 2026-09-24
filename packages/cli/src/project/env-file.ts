/**
 * `.env` (the project's secrets, mode 0600, never committed) and `.env.example` (the variables the
 * installed components read, committed, no values).
 *
 * `.env.example` has one block per component, which `pikit add` appends and `pikit remove`
 * deletes: a `# <component>` line, one commented description and one `NAME=` line per variable,
 * and a blank line between blocks.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentVariable } from "../registry/manifest.ts";

export const ENV_FILE = ".env";
export const ENV_EXAMPLE = ".env.example";

/** `NAME=value` lines; comments and blank lines ignored, one pair of quotes removed. */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2] ?? "";
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    values.set(match[1] as string, value);
  }
  return values;
}

export function readEnv(projectDir: string): Map<string, string> {
  const path = join(projectDir, ENV_FILE);
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map();
}

/**
 * Sets variables in `.env`, keeping every other line, and leaves the file readable by its owner
 * only. A value is written bare when it is safe for both Compose's and Bun's readers, single-quoted
 * otherwise; a newline is refused.
 */
export function writeEnv(projectDir: string, values: ReadonlyMap<string, string>): void {
  const path = join(projectDir, ENV_FILE);
  const lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
  for (const [name, value] of values) {
    if (/[\r\n]/.test(value)) throw new Error(`the value of ${name} has a line break; .env cannot hold it`);
    const bare = /^[A-Za-z0-9_\-.:/+=@,]*$/.test(value);
    if (!bare && value.includes("'")) throw new Error(`the value of ${name} has a quote (') and other symbols; set it in .env by hand`);
    const text = `${name}=${bare ? value : `'${value}'`}`;
    const at = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
    if (at === -1) lines.push(text);
    else lines[at] = text;
  }
  writeFileSync(path, `${lines.filter((l, i) => l !== "" || i > 0).join("\n")}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; an existing file is narrowed too.
  chmodSync(path, 0o600);
}

/** The block `pikit add` appends for a component; empty when it reads no variable. */
export function exampleBlock(component: string, variables: readonly EnvironmentVariable[]): string {
  if (variables.length === 0) return "";
  const lines = [`# ${component}`];
  for (const v of variables) {
    const traits = [v.required ? "required" : "optional", ...(v.secret ? ["secret"] : [])].join(", ");
    lines.push(`# ${v.description ? `${v.description} ` : ""}(${traits})`, `${v.name}=`);
  }
  return `${lines.join("\n")}\n`;
}

export function appendExampleBlock(text: string, block: string): string {
  if (block === "") return text;
  if (text.trim() === "") return block;
  return `${text.replace(/\n*$/, "\n")}\n${block}`;
}

/** Removes the component's block and the blank line that separated it; no block, no change. */
export function removeExampleBlock(text: string, component: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`# ${component}`);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "") end++;
  // The blank line before the block goes with it, or the one after it for the first block.
  if (start > 0 && lines[start - 1] === "") lines.splice(start - 1, end - start + 1);
  else lines.splice(start, Math.min(end + 1, lines.length) - start);
  return lines.join("\n");
}
