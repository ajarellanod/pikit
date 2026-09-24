/**
 * `pikit registry validate | generate [root]` (SPEC §10.2, §10.4, §14). The repository's
 * `bun run registry …` is a thin caller of this same function, so the two cannot disagree.
 */

import { DEFAULT_REGISTRY } from "../paths.ts";
import { generate, validate } from "../registry/commands.ts";

/** Prints one line per problem and returns the process exit code. */
export async function registryCommand(command: string | undefined, root: string = DEFAULT_REGISTRY): Promise<number> {
  if (command !== "generate" && command !== "validate") {
    console.error("usage: pikit registry generate|validate [registry-root]");
    return 2;
  }
  const outcome = command === "generate" ? await generate(root) : await validate(root);
  for (const problem of outcome.problems) console.error(`✗ ${problem}`);
  if (outcome.problems.length > 0) {
    console.error(`registry ${command}: ${outcome.problems.length} problem(s)`);
    return 1;
  }
  console.log(command === "generate" ? `registry generate: wrote ${outcome.written.length} file(s)` : "registry validate: ok");
  return 0;
}
