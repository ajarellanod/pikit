/**
 * The deployer's process: compose.yaml's `deployer` service runs `bun src/pikit/deployment-docker/deployer-main.ts`
 * in its own image (the Dockerfile's `deployer` stage), with the Docker socket, the project's
 * directory at `/project`, the app's state volume at `/state` and its own volume at `/checks`. It
 * deploys the proposals an operator approves (`deployer.ts`) until SIGTERM.
 */

import { runDeployer } from "./deployer.ts";

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());
await runDeployer({ signal: controller.signal });
