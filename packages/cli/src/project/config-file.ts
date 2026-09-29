/**
 * Edits to `pikit.config.ts`, the composition root (SPEC §4.1). `pikit add` and `pikit remove` keep
 * it explicit and readable: one import line per component and one entry per line in `components`.
 *
 * The edits are textual and deliberately narrow. The file is the user's, so when its shape is not
 * the one below the CLI stops with an error that says what to change, instead of guessing:
 *
 *   import channelHttp from "./src/pikit/channel-http/index.ts";   ← one line per import
 *   export const config = {                                         ← values, keyed by component
 *     "router-basic": { defaultAgent: "assistant" },
 *   };
 *   export default defineApp({
 *     components: [
 *       channelHttp,                                                 ← one entry per line
 *     ],
 *     config,
 *   });
 *
 * A project on Cloudflare has a second App in the same shape (SPEC C1): `export const worker =
 * defineApp({ components: [ … ], config: workerConfig })`, with `export const workerConfig = { … }`.
 * `addComponent` lists a component there too when asked (`worker`); `removeComponent` takes its
 * entries out of every list.
 */

// Comments are blanked before looking for a name, so a name in a comment does not count as a use.
import { stripComments } from "../registry/imports.ts";

export const CONFIG_FILE = "pikit.config.ts";

/** `channel-http` → `channelHttp`: the name a component's default export is imported under. */
export function identifierFor(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Where a component's entry point is, relative to `pikit.config.ts`. */
export function entryPath(name: string): string {
  return `./src/pikit/${name}/index.ts`;
}

export interface ComponentEntry {
  name: string;
  /** What the import binds: `channelHttp` (the default export) or `{ createRuntimePi }`. */
  importClause?: string;
  /** The expression listed in `components`: `channelHttp` or `createRuntimePi({ … })`. */
  entry?: string;
  /** The expression listed in the Worker's App (`export const worker`), when it goes there too. */
  worker?: string;
}

/** The object holding the Worker's App's config, in a project on Cloudflare. */
export const WORKER_CONFIG = "workerConfig";

class ShapeError extends Error {
  constructor(problem: string) {
    super(`${CONFIG_FILE}: ${problem}. Edit it by hand (SPEC §4.1), then run the command again.`);
  }
}

/** Adds the component's import after the last import, and its entry at the end of `components`. */
export function addComponent(text: string, component: ComponentEntry): string {
  const identifier = identifierFor(component.name);
  const importClause = component.importClause ?? identifier;
  const entry = component.entry ?? identifier;
  const path = entryPath(component.name);
  if (text.includes(`"${path}"`)) throw new ShapeError(`it already imports "${path}"`);
  for (const name of boundNames(importClause)) {
    if (new RegExp(`\\b${name}\\b`).test(stripComments(text))) {
      throw new ShapeError(`the name "${name}" is already used; rename it there so "${component.name}" can be imported as ${name}`);
    }
  }

  // The lists first: inserting the import shifts every index below it.
  let withEntry = appendEntry(text, componentsList(text), entry);
  if (component.worker !== undefined) withEntry = appendEntry(withEntry, componentsList(withEntry, "worker"), component.worker);

  const imports = [...withEntry.matchAll(IMPORT)];
  const last = imports.at(-1);
  if (last === undefined) throw new ShapeError("it has no import statements (it must at least import defineApp)");
  const at = last.index + last[0].length;
  // The file's own style: prettier's `semi: false` writes imports without `;`.
  const semi = /;[ \t]*(?:\/\/[^\n]*)?\n$/.test(last[0]) ? ";" : "";
  return `${withEntry.slice(0, at)}import ${importClause} from "${path}"${semi}\n${withEntry.slice(at)}`;
}

function appendEntry(text: string, list: ListPosition, entry: string): string {
  return `${text.slice(0, list.closeLineStart)}${list.indent}${entry},\n${text.slice(list.closeLineStart)}`;
}

/**
 * An import statement starting a line, up to the end of the line its module specifier is on, with or
 * without `;`: `import x from "m"`, `import { a,\n b } from "m";`, `import "m"`. Its clause never holds
 * a quote or a `;`, so a match cannot run past its own specifier into the code after, whatever the
 * file's semicolons. Not `import(…)` nor `import.meta`.
 */
const IMPORT = /^import\b(?!\s*[(.])[^"'`;]*["'][^"'\n]*["'][^\n]*\n/gm;

/**
 * Removes the component's import lines and every `components` entry that uses what they bind, in
 * every App's list. A component that was never listed (a `deployment-*`) leaves the text unchanged.
 */
export function removeComponent(text: string, name: string): string {
  // The clause holds no quote, so a match cannot start at an earlier import (a file without `;`).
  const importLine = new RegExp(`^import\\s+([^;"'\`]+?)\\s+from\\s+["']\\./src/pikit/${escape(name)}/[^"']*["'];?[^\\n]*\\n`, "gm");
  const imports = [...text.matchAll(importLine)];
  if (imports.length === 0) return text;
  const names = imports.flatMap((m) => boundNames(m[1] ?? ""));

  // Every top-level entry that uses what the imports bind goes, whole, even over several lines, from
  // each App's list: the default export's (checked for its shape, as `add` needs it) and any other.
  componentsList(text);
  const removals: [number, number][] = [];
  for (const list of text.matchAll(COMPONENTS)) {
    const open = list.index + list[0].length - 1;
    const close = matchClose(text, open);
    for (let i = open + 1; ; ) {
      const start = skipSpaces(text, i);
      if (start >= close) break;
      let end = skipValue(text, start);
      const entry = text.slice(start, end);
      if (text[end] === ",") end++;
      i = end;
      if (!names.some((n) => new RegExp(`\\b${escape(n)}\\b`).test(stripComments(entry)))) continue;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = text.indexOf("\n", end);
      if (text.slice(lineStart, start).trim() !== "" || lineEnd === -1 || text.slice(end, lineEnd).trim() !== "") {
        throw new ShapeError(`the entry "${entry.trim()}" of "${name}" shares its line with another entry`);
      }
      removals.push([lineStart, lineEnd + 1]);
    }
  }
  let next = text;
  for (const [from, to] of removals.sort(([a], [b]) => b - a)) next = next.slice(0, from) + next.slice(to);
  for (const m of [...next.matchAll(importLine)].reverse()) next = next.slice(0, m.index) + next.slice(m.index + m[0].length);

  const stillUsed = names.filter((n) => new RegExp(`\\b${escape(n)}\\b`).test(stripComments(next)));
  if (stillUsed.length > 0) {
    throw new ShapeError(`${stillUsed.join(", ")} (from "${name}") is still used outside the components list`);
  }
  return next;
}

/** Sets `config["<name>"]` to `value` (TypeScript source), adding the key at the end of `config`. */
export function setConfigEntry(text: string, name: string, value: string): string {
  const object = configObject(text);
  if (object === undefined) throw new ShapeError("it has no `const config = { … }`");
  if (findConfigKey(text, object, name) !== undefined) throw new ShapeError(`config already has "${name}"`);
  const line = `"${name}": ${value},`;
  if (text.slice(object.open + 1, object.close).trim() === "") {
    return `${text.slice(0, object.open + 1)}\n  ${line}\n${text.slice(object.close)}`;
  }
  const closeLineStart = text.lastIndexOf("\n", object.close - 1) + 1;
  if (text.slice(closeLineStart, object.close).trim() !== "") throw new ShapeError("the closing `}` of config is not on its own line");
  return `${text.slice(0, closeLineStart)}  ${line}\n${text.slice(closeLineStart)}`;
}

/**
 * Removes `config["<name>"]`, however many lines its value takes; `object` names another config
 * object (`workerConfig`). No key, or no such object, no change.
 */
export function removeConfigEntry(text: string, name: string, objectName = "config"): string {
  const object = configObject(text, objectName);
  if (object === undefined) return text;
  const key = findConfigKey(text, object, name);
  if (key === undefined) return text;
  let end = skipValue(text, key.valueStart);
  end = skipSpaces(text, end);
  if (text[end] === ",") end++;
  const lineEnd = text.indexOf("\n", end);
  if (lineEnd !== -1 && text.slice(end, lineEnd).trim() === "") end = lineEnd + 1;
  const lineStart = text.lastIndexOf("\n", key.start - 1) + 1;
  const start = text.slice(lineStart, key.start).trim() === "" ? lineStart : key.start;
  const next = text.slice(0, start) + text.slice(end);
  // `{\n}` left behind by the last key goes back to `{}`.
  const after = configObject(next, objectName);
  if (after !== undefined && next.slice(after.open + 1, after.close).trim() === "") {
    return next.slice(0, after.open + 1) + next.slice(after.close);
  }
  return next;
}

interface ListPosition {
  /** Index of `[`. */
  open: number;
  /** Start of the line holding the closing `]`. */
  closeLineStart: number;
  indent: string;
}

const COMPONENTS = /\bcomponents\s*:\s*\[/g;

/**
 * The `components: [` list of an App: for the default one, the only list, or, in a file with several
 * Apps (a Cloudflare project's, SPEC C1), the one of `export default defineApp({ … })`; for the
 * Worker's, the one of `export const worker = defineApp({ … })`.
 */
function componentsList(text: string, app: "default" | "worker" = "default"): ListPosition {
  let matches = [...text.matchAll(COMPONENTS)];
  if (app === "worker" || matches.length > 1) {
    const found = (app === "worker" ? /^export\s+const\s+worker\s*=\s*defineApp\s*\(\s*\{/m : /^export\s+default\s+defineApp\s*\(\s*\{/m).exec(text);
    if (found === null && app === "worker") {
      throw new ShapeError("it has no `export const worker = defineApp({ components: [ … ], config: workerConfig })`, the Worker's App of a project on Cloudflare (SPEC C1)");
    }
    if (found !== null) {
      const open = found.index + found[0].length - 1;
      const close = matchClose(text, open);
      matches = matches.filter((m) => m.index > open && m.index < close);
    }
  }
  if (matches.length !== 1) {
    const where = app === "worker" ? "`export const worker`" : "its default export";
    throw new ShapeError(`it must have exactly one \`components: [\` list in ${where}, found ${matches.length}`);
  }
  const match = matches[0] as RegExpExecArray;
  const open = match.index + match[0].length - 1;
  const close = matchClose(text, open);
  const closeLineStart = text.lastIndexOf("\n", close - 1) + 1;
  if (closeLineStart <= open || text.slice(closeLineStart, close).trim() !== "") {
    throw new ShapeError("the `components` list must have one entry per line and its closing `]` on its own line");
  }
  const closeIndent = /^[ \t]*/.exec(text.slice(closeLineStart))?.[0] ?? "";
  const firstEntry = /\n([ \t]+)\S/.exec(text.slice(open, closeLineStart));
  return { open, closeLineStart, indent: firstEntry?.[1] ?? `${closeIndent}  ` };
}

function configObject(text: string, name = "config"): { open: number; close: number } | undefined {
  const match = new RegExp(`\\bconst\\s+${escape(name)}\\b[^=]*=\\s*\\{`).exec(text);
  if (match === null) return undefined;
  const open = match.index + match[0].length - 1;
  return { open, close: matchClose(text, open) };
}

/** A key of the config object at its top level: `"name":`, `'name':` or `name:`. */
function findConfigKey(text: string, object: { open: number; close: number }, name: string): { start: number; valueStart: number } | undefined {
  let i = object.open + 1;
  while (i < object.close) {
    i = skipSpaces(text, i);
    if (i >= object.close) return undefined;
    const keyMatch = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(text.slice(i, object.close));
    if (keyMatch === null) throw new ShapeError("config must be an object literal of `\"component-name\": { … }` entries");
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3];
    const valueStart = i + keyMatch[0].length;
    if (key === name) return { start: i, valueStart };
    i = skipSpaces(text, skipValue(text, valueStart));
    if (text[i] === ",") i++;
  }
  return undefined;
}

/** Index just past the value starting at (or after spaces from) `from`: up to a top-level `,` or `}`. */
function skipValue(text: string, from: number): number {
  let i = skipSpaces(text, from);
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "," || c === "}" || c === "]" || c === ")") return i;
    if (c === "{" || c === "[" || c === "(") i = matchClose(text, i) + 1;
    else if (c === '"' || c === "'" || c === "`") i = skipString(text, i);
    else i++;
  }
  return i;
}

function skipSpaces(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    if (text.startsWith("//", i)) i = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) === -1 ? text.length : text.indexOf("*/", i) + 2;
    else return i;
  }
}

/** Index of the bracket that closes the one at `open`; strings and comments skipped. */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];
  let i = open;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      i = skipSpaces(text, i);
      continue;
    }
    if (c in pairs) stack.push(pairs[c] as string);
    else if (c === "}" || c === "]" || c === ")") {
      if (stack.pop() !== c) throw new ShapeError(`unbalanced "${c}"`);
      if (stack.length === 0) return i;
    }
    i++;
  }
  throw new ShapeError(`"${text[open]}" is never closed`);
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return i;
}

/** The local names an import clause binds: `a`, `{ b, c as d }`, `* as e`. */
export function boundNames(clause: string): string[] {
  const names: string[] = [];
  const text = clause.replace(/^type\s+/, "");
  const named = /\{([^}]*)\}/.exec(text);
  if (named) {
    for (const part of (named[1] ?? "").split(",")) {
      const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)?.trim();
      if (local) names.push(local);
    }
  }
  const rest = text.replace(/\{[^}]*\}/, "");
  const ns = /\*\s+as\s+([\w$]+)/.exec(rest);
  if (ns?.[1]) names.push(ns[1]);
  const def = /^\s*([\w$]+)/.exec(rest.replace(/\*\s+as\s+[\w$]+/, ""));
  if (def?.[1]) names.push(def[1]);
  return names;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
