/**
 * The registry's manifests, generated and checked (SPEC §10.2, §10.4, §14).
 *
 *   bun run registry generate [root]   rewrite the fields setup declares, rebuild registry.json
 *   bun run registry validate [root]   check every component, preset and schema; exit 1 on any problem
 *   bun run registry capabilities [root]   what each capability is, and who provides and uses it
 *
 * `root` defaults to this repository's `registry/`. A thin caller of `pikit registry`: the code is
 * the CLI's (`packages/cli/src/registry/`), so both run exactly the same checks.
 */

import { registryCommand } from "../packages/cli/src/commands/registry.ts";

const [command, root] = process.argv.slice(2);
process.exit(await registryCommand(command, root));
