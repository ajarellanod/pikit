/**
 * `workspace` conformance (SPEC §8.2, §14). The contract is typed by the adapter (its `env` is Pi's
 * `ExecutionEnv`), so its suite lives here, next to `execution`'s. Runner-independent:
 *
 *   for (const c of createWorkspaceConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * It checks what the tool components rely on when they resolve a run's workspace on every call:
 * - a conversation's workspace works: a file written through its `env` reads back;
 * - resolving the same conversation again finds that file, so a later call, or the next run, sees
 *   what an earlier one wrote;
 * - two agents' workspaces are apart: what one writes at a relative path is not at that path in the
 *   other's.
 * The environment itself is `execution`'s contract: run `createExecutionConformance` on it too.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { ConversationRef } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { WorkspaceProvider } from "../types.ts";

/** A provider built for one case, over storage no other case uses. */
export interface WorkspaceFixture {
  provider: WorkspaceProvider;
  /** Release what the fixture holds (the directory, the app). */
  dispose?(): Promise<void>;
}

const GROUP = "workspace";
const ctx = BACKGROUND_CONTEXT;

function conversation(agent: string, id: string): ConversationRef {
  return { key: `conformance:${agent}:${id}`, agent, sessionId: `session-${agent}-${id}` };
}

export function createWorkspaceConformance(factory: () => WorkspaceFixture | Promise<WorkspaceFixture>): readonly ConformanceCase[] {
  const workspaceCase = (name: string, run: (provider: WorkspaceProvider) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture.provider);
      } finally {
        await fixture.dispose?.();
      }
    },
  });

  return [
    workspaceCase("a conversation's workspace keeps what its tools write", async (provider) => {
      const support = conversation("support", "1");
      const first = await provider.resolve(support, ctx);
      value(await first.env.writeFile("notes/a.txt", "kept", ctx), "writeFile");

      const again = await provider.resolve(support, ctx);

      expect(value(await again.env.readTextFile("notes/a.txt", ctx), "readTextFile"), "kept", "the file, resolved again");
    }),

    workspaceCase("two agents' workspaces are apart", async (provider) => {
      const support = await provider.resolve(conversation("support", "1"), ctx);
      const ops = await provider.resolve(conversation("ops", "1"), ctx);

      value(await support.env.writeFile("mine.txt", "support's", ctx), "writeFile");

      expect(value(await ops.env.exists("mine.txt", ctx), "exists"), false, "support's file in ops' workspace");
      expect(value(await support.env.exists("mine.txt", ctx), "exists"), true, "support's file in its own workspace");
    }),
  ];
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }, what: string): T {
  if (!result.ok) throw new Error(`${GROUP}: ${what} failed: ${result.error.code ?? ""} ${result.error.message}`);
  return result.value;
}

function expect(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
