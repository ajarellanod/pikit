/**
 * Every module specifier a source file imports, type-only imports included.
 *
 * Why not `Bun.Transpiler.scanImports`: it drops `import type`, and a type-only import still needs
 * its package installed to typecheck, so it counts as a dependency and as coupling (S4). Why strip
 * comments first: component files document themselves with examples such as
 * `import x from "..."`, which must not count as imports.
 */

/** Specifiers in source order, deduplicated. */
export function scanImports(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  const patterns = [
    // import x from "m" · import type { X } from "m" · export { x } from "m" · export * from "m"
    /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/g,
    // import "m" (side effect)
    /\bimport\s*(["'])([^"'\n]+)\1/g,
    // import("m") · require("m")
    /\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  ];
  const hits: { at: number; specifier: string }[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) hits.push({ at: match.index, specifier: match[2] ?? "" });
  }
  for (const { specifier } of hits.sort((a, b) => a.at - b.at)) found.add(specifier);
  return [...found];
}

/**
 * Comments replaced by spaces; strings, template literals and regular expressions kept, so a
 * `//` inside a URL or a regex does not start a comment. The regex rule is the usual heuristic:
 * a `/` after an operator or at the start of an expression begins a regex, anything else divides.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let previous = ""; // last significant character outside comments, for the regex heuristic
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipQuoted(source, i, c);
      out += source.slice(i, end);
      previous = c;
      i = end;
      continue;
    }
    if (c === "/" && (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous))) {
      const end = skipRegex(source, i);
      out += source.slice(i, end);
      previous = "/";
      i = end;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) previous = c;
    i++;
  }
  return out;
}

/** Index just past the closing quote (or the end of the source). */
function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else if (c === "\n" && quote !== "`") return i; // an unterminated string ends at the line
    else i++;
  }
  return i;
}

/** Index just past a regex literal's closing `/` and flags; `/` inside `[...]` does not close it. */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === "\n") return i;
    else if (c === "[") (inClass = true), i++;
    else if (c === "]") (inClass = false), i++;
    else if (c === "/" && !inClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i] ?? "")) i++;
      return i;
    } else i++;
  }
  return i;
}

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** A specifier that names a runtime module (`node:fs`, `bun:test`, `cloudflare:workers`). */
export function runtimeScheme(specifier: string): "node" | "bun" | "cloudflare" | undefined {
  const match = /^(node|bun|cloudflare):/.exec(specifier);
  return match ? (match[1] as "node" | "bun" | "cloudflare") : undefined;
}

export function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}
