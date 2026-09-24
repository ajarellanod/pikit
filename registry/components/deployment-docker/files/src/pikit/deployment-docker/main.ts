/**
 * The container's process: `bun src/pikit/deployment-docker/main.ts` (the Dockerfile's `CMD`).
 * It runs the project's composition root, `pikit.config.ts`, through the entrypoint (SPEC §9.1).
 * Change the deadlines or the logger here, in `runEntrypoint`'s options.
 */

// @ts-ignore: in the registry this file has no project around it. Installed at
// `src/pikit/deployment-docker/`, the import resolves to the project's root and is type-checked.
import definition from "../../../pikit.config.ts";
import { runEntrypoint } from "./entrypoint.ts";

await runEntrypoint(definition);
