/**
 * The `workspace` suite run against its simplest double: Pi's `NodeExecutionEnv` per agent, in a
 * directory of its own. `workspace-local` runs it against the real provider.
 */

import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createWorkspaceConformance } from "./workspace.ts";

for (const c of createWorkspaceConformance(() => {
  const root = mkdtempSync(join(tmpdir(), "pikit-workspace-"));
  const envs = new Map<string, ExecutionEnv>();
  return {
    provider: {
      async resolve(conversation) {
        let env = envs.get(conversation.agent);
        if (env === undefined) envs.set(conversation.agent, (env = new NodeExecutionEnv({ cwd: join(root, conversation.agent) })));
        return { env };
      },
    },
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  };
})) {
  test(`a directory per agent ${c.group}: ${c.name}`, () => c.run());
}
