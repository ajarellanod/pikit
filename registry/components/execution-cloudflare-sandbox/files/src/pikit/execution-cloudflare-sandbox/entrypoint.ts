/**
 * The project's `Sandbox` Durable Object class, over `pikit.config.ts`'s default export. The sandbox
 * host project's Worker exports it: one line added to `src/pikit/deployment-cloudflare/worker.ts`,
 *
 *   export { Sandbox } from "../execution-cloudflare-sandbox/entrypoint.ts";
 *
 * and `wrangler.jsonc` binds it with its container (this component's README).
 */

import type { AppDefinition } from "@pikit/core";
// @ts-ignore: in the registry this file has no project around it. Installed at
// `src/pikit/execution-cloudflare-sandbox/`, the import resolves to the project's root and is type-checked.
import * as project from "../../../pikit.config.ts";
import { createSandboxClass } from "./durable-object.ts";

export const Sandbox = createSandboxClass((project as { default: AppDefinition }).default);
