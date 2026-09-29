/**
 * What pikit gives a Pi extension (tier A), read from the adapter's sources, and the CLI's copy
 * of it. `pikit doctor` checks a project's extensions against that copy
 * (`packages/cli/src/project/pi-extension-surface.ts`): the CLI does not load the adapter, so the
 * list is generated here and `scripts/pi-extension-surface.test.ts` fails when it is stale.
 *
 *   bun scripts/pi-extension-surface.ts          rewrite the CLI's copy
 *   bun scripts/pi-extension-surface.ts --check  exit 1 when it is stale
 *
 * The parsers read TypeScript declarations with regular expressions, as `registry/imports.ts`
 * reads imports. They are strict on pikit's own files (an `export` they do not understand throws,
 * so a new form cannot slip past the list) and shared with `pi-extension-drift.ts`, which reads Pi's.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripComments } from "../packages/cli/src/registry/imports.ts";
import { SUPPORTED_EVENTS } from "../packages/pi-adapter/src/extensions/surface.ts";

const ROOT = join(import.meta.dir, "..");
export const EXTENSIONS_DIR = join(ROOT, "packages", "pi-adapter", "src", "extensions");
export const CLI_COPY = join(ROOT, "packages", "cli", "src", "project", "pi-extension-surface.ts");

export interface ModuleExports {
  values: string[];
  types: string[];
  /** Specifiers of `export * from "…"`. */
  starFrom: string[];
}

/**
 * The names a module exports, from its `export` statements. `strict` throws on an `export` it does
 * not understand; Pi's files are read leniently.
 */
export function exportedNames(source: string, strict = true): ModuleExports {
  const code = stripComments(source);
  const values = new Set<string>();
  const types = new Set<string>();
  const starFrom: string[] = [];
  let understood = 0;
  const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|enum|interface|type)\s+([\w$]+)/gm;
  for (const [, kind, name = ""] of code.matchAll(declaration)) {
    (kind === "interface" || kind === "type" ? types : values).add(name);
    understood++;
  }
  for (const [, typeOnly, list = ""] of code.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    for (const part of list.split(",")) {
      const entry = part.trim();
      if (entry === "") continue;
      const isType = typeOnly !== undefined || entry.startsWith("type ");
      const exported = entry.replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)?.trim() ?? "";
      (isType ? types : values).add(exported);
    }
    understood++;
  }
  for (const [, specifier = ""] of code.matchAll(/^export\s*\*\s*from\s*["']([^"']+)["']/gm)) {
    starFrom.push(specifier);
    understood++;
  }
  const statements = [...code.matchAll(/^export\b/gm)].length;
  if (strict && statements !== understood) throw new Error(`${statements - understood} export statement(s) not understood`);
  // Overloads repeat a function's name; a name exported as a value is a value.
  for (const name of values) types.delete(name);
  return { values: [...values].sort(), types: [...types].sort(), starFrom };
}

/** The exports of a module of pikit's, following its relative `export * from`. */
export function moduleExports(file: string): { values: string[]; types: string[] } {
  const own = exportedNames(readFileSync(file, "utf8"));
  const values = new Set(own.values);
  const types = new Set(own.types);
  for (const specifier of own.starFrom) {
    if (!specifier.startsWith(".")) throw new Error(`${file}: export * from "${specifier}" is not followed`);
    const target = resolve(dirname(file), specifier);
    const inner = moduleExports(existsSync(target) ? target : `${target}.ts`);
    for (const name of inner.values) values.add(name);
    for (const name of inner.types) types.add(name);
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

/** The body of `interface <name> { … }`, without its braces. */
function interfaceBody(source: string, name: string): string {
  const code = stripComments(source);
  const start = new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`).exec(code);
  if (start === null) throw new Error(`interface ${name} not found`);
  let depth = 1;
  const from = start.index + start[0].length;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(from, i);
  }
  throw new Error(`interface ${name} is not closed`);
}

/** The members of an interface: properties and methods declared at its top level. */
export function interfaceMembers(source: string, name: string): string[] {
  const body = interfaceBody(source, name);
  const members = new Set<string>();
  let depth = 0; // braces, parentheses and brackets inside the body
  let lineStart = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? "";
    if (c === "\n") {
      lineStart = true;
      continue;
    }
    if (lineStart && depth === 0 && /\S/.test(c)) {
      const member = /^(?:readonly\s+)?([\w$]+)\s*\??\s*[(:<]/.exec(body.slice(i));
      if (member?.[1] !== undefined) members.add(member[1]);
    }
    if (/\S/.test(c)) lineStart = false;
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
  }
  return [...members].sort();
}

/**
 * The members of the tool interfaces: `ToolDefinition` (what `pi.registerTool()` takes) and
 * `ExtensionToolContext` (the `ctx` of a tool's `execute()`: its own members, over `ExtensionContext`).
 * A source without `ExtensionToolContext` (Pi before 0.99) has none of the latter.
 */
export function toolMembers(source: string): { toolDefinition: string[]; toolContext: string[] } {
  const hasToolContext = /\binterface\s+ExtensionToolContext\b/.test(stripComments(source));
  return {
    toolDefinition: interfaceMembers(source, "ToolDefinition"),
    toolContext: hasToolContext ? interfaceMembers(source, "ExtensionToolContext") : [],
  };
}

/** What Pi has that pikit lacks, and the reverse, of two lists of names. */
export function drift(pi: readonly string[], pikit: readonly string[]): { lacks: string[]; extra: string[] } {
  const theirs = new Set(pi);
  const ours = new Set(pikit);
  return { lacks: pi.filter((name) => !ours.has(name)), extra: pikit.filter((name) => !theirs.has(name)) };
}

/** The events an interface's `on(event: "…", …)` overloads name. */
export function eventNames(source: string, name = "ExtensionAPI"): string[] {
  const body = interfaceBody(source, name);
  return [...new Set([...body.matchAll(/\bon\s*\(\s*event\s*:\s*["']([\w]+)["']/g)].map((m) => m[1] ?? ""))].sort();
}

export interface Surface {
  /** Every name `@earendil-works/pi-coding-agent` resolves to in a project (the shim), values and types. */
  shimExports: string[];
  /** Events pikit fires (host.ts). */
  supportedEvents: string[];
  /** Members of pikit's `ExtensionAPI`; anything else an extension calls on `pi` is a `TypeError`. */
  apiMembers: string[];
  /** Members of pikit's `ExtensionContext`. */
  contextMembers: string[];
}

export function localSurface(): Surface {
  const exports = moduleExports(join(EXTENSIONS_DIR, "index.ts"));
  const api = readFileSync(join(EXTENSIONS_DIR, "api.ts"), "utf8");
  return {
    shimExports: [...new Set([...exports.values, ...exports.types])].sort(),
    supportedEvents: [...SUPPORTED_EVENTS].sort(),
    apiMembers: interfaceMembers(api, "ExtensionAPI"),
    contextMembers: interfaceMembers(api, "ExtensionContext"),
  };
}

export function render(surface: Surface): string {
  const list = (name: string, doc: string, values: string[]) =>
    `/** ${doc} */\nexport const ${name}: readonly string[] = [\n${values.map((v) => `  ${JSON.stringify(v)},\n`).join("")}];\n`;
  return [
    "// Generated by `bun scripts/pi-extension-surface.ts` from packages/pi-adapter/src/extensions: do not edit.",
    "// What pikit gives a Pi extension (tier A), for `pikit doctor`, which does not load the adapter.",
    "// `scripts/pi-extension-surface.test.ts` fails when this file is stale.",
    "",
    list("SHIM_EXPORTS", "Every name `@earendil-works/pi-coding-agent` exports in a pikit project (values and types).", surface.shimExports),
    list("SUPPORTED_EVENTS", "The events pikit fires; an extension may register others, which never fire.", surface.supportedEvents),
    list("API_MEMBERS", "The members of pikit's `ExtensionAPI` (`pi.*`).", surface.apiMembers),
    list("CONTEXT_MEMBERS", "The members of pikit's `ExtensionContext` (`ctx.*`).", surface.contextMembers),
  ].join("\n");
}

if (import.meta.main) {
  const text = render(localSurface());
  const current = existsSync(CLI_COPY) ? readFileSync(CLI_COPY, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (current !== text) {
      console.error(`${CLI_COPY} is stale: run bun scripts/pi-extension-surface.ts`);
      process.exit(1);
    }
    console.log("pi extension surface: up to date");
  } else if (current !== text) {
    writeFileSync(CLI_COPY, text);
    console.log(`wrote ${CLI_COPY}`);
  } else console.log("pi extension surface: up to date");
}
