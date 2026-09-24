/**
 * The registry's manifests, generated and checked (SPEC §10.2, §10.4, §14).
 *
 *   bun run registry generate [root]   rewrite the fields setup declares, rebuild registry.json
 *   bun run registry validate [root]   check every component; exit 1 on any problem
 *
 * `root` defaults to this repository's `registry/`. `pikit registry validate` will call `validate`.
 */

import { join } from "node:path";
import { generate, validate } from "./registry/commands.ts";

const [command, rootArg] = process.argv.slice(2);
const root = rootArg ?? join(import.meta.dir, "..", "registry");

if (command !== "generate" && command !== "validate") {
  console.error("usage: bun scripts/registry.ts generate|validate [registry-root]");
  process.exit(2);
}

const outcome = command === "generate" ? await generate(root) : await validate(root);
for (const problem of outcome.problems) console.error(`✗ ${problem}`);
if (outcome.problems.length > 0) {
  console.error(`registry ${command}: ${outcome.problems.length} problem(s)`);
  process.exit(1);
}
console.log(command === "generate" ? `registry generate: wrote ${outcome.written.length} file(s)` : "registry validate: ok");
