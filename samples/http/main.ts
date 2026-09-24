/**
 * Runs the sample: `bun samples/http/main.ts`, and the process of its container (`Dockerfile`).
 *
 * It is `deployment-docker`'s `main.ts` (SPEC §9.1): start with a deadline, stop on SIGTERM or
 * SIGINT with a deadline, exit non-zero when either fails, JSON-lines logs. In a project that
 * component's own `src/pikit/deployment-docker/main.ts` runs `pikit.config.ts`. This fixture imports
 * the entrypoint straight from `registry/` because there is no CLI to copy it yet.
 */

import { runEntrypoint } from "../../registry/components/deployment-docker/files/src/pikit/deployment-docker/entrypoint.ts";
import definition from "./pikit.config.ts";

await runEntrypoint(definition);
