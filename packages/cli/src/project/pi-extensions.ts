/**
 * What a project's Pi extensions use that pikit does not provide (SPEC §6.2b), for `pikit doctor`,
 * so an extension copied from Pi fails there, with its reason, and not at run time with a cryptic
 * error.
 *
 * It reads the project's own files that import `@earendil-works/pi-coding-agent` (the shim's alias),
 * never runs them, and checks them against the CLI's generated copy of the adapter's surface
 * (`pi-extension-surface.ts`):
 * - **Problems** are facts: a name imported from the alias that the shim does not export, or a
 *   subpath of it. The module does not load (a value) or does not typecheck (a type).
 * - **Notes** are heuristics, so they never fail the command: events pikit never fires, `pi.*` and
 *   `ctx.*` members it lacks or leaves inert, terminal UI calls. One note per file lists them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageName, scanImports, stripComments } from "../registry/imports.ts";
import { API_MEMBERS, CONTEXT_MEMBERS, SHIM_EXPORTS, SUPPORTED_EVENTS } from "./pi-extension-surface.ts";
import { EXTENSION_ALIAS } from "./vendor.ts";

/** `pi.*` members that exist so an extension loads, and do nothing in pikit (tiers B and C). */
const INERT_API = new Set([
  "registerCommand",
  "registerShortcut",
  "registerFlag",
  "getFlag",
  "registerMessageRenderer",
  "registerEntryRenderer",
  "registerMarkdownTransformer",
  "exec",
]);
/** `ctx.*` members that exist and do nothing in pikit. */
const INERT_CONTEXT = new Set(["shutdown"]);
/** The `ctx.ui` calls with an answer when there is no UI; every other `ui.*` is terminal UI. */
const UI_ANSWERED = new Set(["select", "confirm", "input", "notify"]);

const shimExports = new Set(SHIM_EXPORTS);
const supportedEvents = new Set(SUPPORTED_EVENTS);
const apiMembers = new Set(API_MEMBERS);
const contextMembers = new Set(CONTEXT_MEMBERS);

export interface ExtensionFindings {
  /** Names imported from the alias that the shim does not export. */
  missing: string[];
  /** Subpaths of the alias (`@earendil-works/pi-coding-agent/…`): the shim has none. */
  subpaths: string[];
  /** What the file uses that pikit does not provide or leaves inert, as written (`pi.on("input")`). */
  unsupported: string[];
}

/** The findings of one source file that imports the alias. */
export function inspectExtension(source: string): ExtensionFindings {
  const code = stripComments(source);
  const missing = new Set<string>();
  const subpaths = scanImports(code).filter((specifier) => packageName(specifier) === EXTENSION_ALIAS && specifier !== EXTENSION_ALIAS);
  const named = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(["'])([^"'\n]+)\2/g;
  for (const [, list = "", , specifier] of code.matchAll(named)) {
    if (specifier !== EXTENSION_ALIAS) continue;
    for (const part of list.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (name !== "" && !shimExports.has(name)) missing.add(name);
    }
  }

  const unsupported = new Set<string>();
  // The names the file gives the API object; Pi's convention is `pi`.
  const apiNames = new Set([...code.matchAll(/\b([\w$]+)\s*:\s*ExtensionAPI\b/g)].map((m) => m[1] ?? ""));
  if (apiNames.size === 0) apiNames.add("pi");
  for (const api of apiNames) {
    const at = api.replace(/\$/g, "\\$");
    for (const [, event = ""] of code.matchAll(new RegExp(`(?<![\\w$.])${at}\\.on\\(\\s*["'\`]([\\w:-]+)["'\`]`, "g"))) {
      if (!supportedEvents.has(event)) unsupported.add(`pi.on("${event}")`);
    }
    for (const [, member = ""] of code.matchAll(new RegExp(`(?<![\\w$.])${at}\\.([\\w$]+)`, "g"))) {
      if (!apiMembers.has(member) || INERT_API.has(member)) unsupported.add(`pi.${member}`);
    }
    // Pi's `registerProvider(name, config)`; pikit takes only a pi-ai provider object.
    if (new RegExp(`(?<![\\w$.])${at}\\.registerProvider\\(\\s*["'\`]`).test(code)) unsupported.add("pi.registerProvider(name, config)");
  }
  for (const [, member = ""] of code.matchAll(/(?<![\w$.])ctx\.([\w$]+)/g)) {
    if (!contextMembers.has(member) || INERT_CONTEXT.has(member)) unsupported.add(`ctx.${member}`);
  }
  for (const member of ["sessionManager", "modelRegistry"]) {
    if (new RegExp(`\\.${member}\\b`).test(code)) unsupported.add(`ctx.${member}`);
  }
  for (const [, method = ""] of code.matchAll(/\.ui\.([\w$]+)/g)) {
    if (!UI_ANSWERED.has(method)) unsupported.add(`ctx.ui.${method}`);
  }
  return { missing: [...missing], subpaths, unsupported: [...unsupported] };
}

/**
 * Problems and notes for the project's Pi extensions: its source files, outside installed
 * components (they may not import Pi at all, S1), that import the alias.
 */
export function checkPiExtensions(projectDir: string, files: readonly string[]): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/pikit/")) continue;
    const source = readFileSync(join(projectDir, file), "utf8");
    if (!scanImports(source).some((specifier) => packageName(specifier) === EXTENSION_ALIAS)) continue;
    const { missing, subpaths, unsupported } = inspectExtension(source);
    for (const specifier of subpaths) {
      problems.push(`${file} imports "${specifier}", which pikit does not provide: only ${EXTENSION_ALIAS} itself (SPEC §6.2b)`);
    }
    if (missing.length > 0) {
      const names = missing.map((name) => `\`${name}\``).join(", ");
      problems.push(`${file} imports ${names} from ${EXTENSION_ALIAS}, which pikit does not provide (SPEC §6.2b)`);
    }
    if (unsupported.length > 0) {
      notes.push(`${file} uses what pikit does not provide to Pi extensions; it does nothing or fails when called (SPEC §6.2b): ${unsupported.join(", ")}`);
    }
  }
  return { problems, notes };
}
