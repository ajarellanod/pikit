/**
 * What Pi's extension API at a tag has that pikit's vendored subset lacks, and the reverse
 * (SPEC §6.2b). Run it before a Pi bump, and when Pi's extension API moves:
 *
 *   bun scripts/pi-extension-drift.ts v0.88.0
 *   bun scripts/pi-extension-drift.ts main
 *
 * It reads Pi's `ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, `ExtensionToolContext` and
 * events (`src/core/extensions/types.ts`) and the exports of `@earendil-works/pi-coding-agent` (`src/index.ts`) with `gh`, and compares
 * them with `packages/pi-adapter/src/extensions`. "pikit has, Pi does not" is what a bump breaks;
 * "Pi has, pikit lacks" is what extensions written for that Pi may use and `pikit doctor` reports.
 * It needs the network, so `bun test` does not run it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  drift,
  EXTENSIONS_DIR,
  eventNames,
  exportedNames,
  interfaceMembers,
  localSurface,
  moduleExports,
  toolMembers,
} from "./pi-extension-surface.ts";

const REPO = "earendil-works/pi";
const TYPES = "packages/coding-agent/src/core/extensions/types.ts";
const INDEX = "packages/coding-agent/src/index.ts";

function fetchPi(path: string, ref: string): string {
  const run = Bun.spawnSync(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`gh api ${path}@${ref} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function compare(title: string, pi: readonly string[], pikit: readonly string[]): void {
  const { lacks, extra } = drift(pi, pikit);
  console.log(`\n${title}`);
  console.log(`  Pi has, pikit lacks (${lacks.length}): ${lacks.join(", ") || "-"}`);
  console.log(`  pikit has, Pi does not (${extra.length}): ${extra.join(", ") || "-"}`);
}

const ref = process.argv[2];
if (ref === undefined || ref.startsWith("-")) {
  console.error("usage: bun scripts/pi-extension-drift.ts <pi tag, branch or commit>");
  process.exit(2);
}

const types = fetchPi(TYPES, ref);
const index = exportedNames(fetchPi(INDEX, ref), false);
const local = localSurface();
const shim = moduleExports(join(EXTENSIONS_DIR, "index.ts"));
const piTools = toolMembers(types);
const localTools = toolMembers(readFileSync(join(EXTENSIONS_DIR, "api.ts"), "utf8"));

console.log(`Pi ${ref} against pikit's extension API (${EXTENSIONS_DIR})`);
if (index.starFrom.length > 0) console.log(`  note: Pi's index re-exports ${index.starFrom.join(", ")} wholesale; those names are not compared`);
compare("Events (pi.on): pikit fires only its own; the others never fire", eventNames(types), local.supportedEvents);
compare("ExtensionAPI members (pi.*): one pikit lacks is a TypeError when called", interfaceMembers(types, "ExtensionAPI"), local.apiMembers);
compare("ExtensionContext members (ctx.*)", interfaceMembers(types, "ExtensionContext"), local.contextMembers);
compare("ToolDefinition members (pi.registerTool): one pikit lacks is ignored, or fails typecheck", piTools.toolDefinition, localTools.toolDefinition);
compare("ExtensionToolContext's own members (a tool's ctx, over ExtensionContext)", piTools.toolContext, localTools.toolContext);
compare("Value exports of @earendil-works/pi-coding-agent: one pikit lacks fails the extension's load", index.values, shim.values);
compare("Type exports of @earendil-works/pi-coding-agent: one pikit lacks fails typecheck", index.types, shim.types);
