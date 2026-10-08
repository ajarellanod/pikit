/**
 * The components' `beforeDeploy` hooks, run on the project in the current directory: what `up` runs
 * before it builds (`commands.ts`), as a program. The deployer runs it in a container of its own (no
 * Docker socket), on the commit it is about to build. Exits 1 with the hooks' problems.
 */

import { runBeforeDeployHooks } from "./commands.ts";

try {
  await runBeforeDeployHooks(process.cwd(), (line) => console.log(line));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
