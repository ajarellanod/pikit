/**
 * Runs a conformance case inside a fresh SQLite-backed Durable Object, with that object in
 * `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint puts it: the Worker's `env`, the
 * object's id and storage, and hooks for its alarm and RPC (recorded, never called here).
 *
 * The suites build their fixtures in a factory the case calls, so a fixture reads the object it runs
 * in from `objectHost()`:
 *
 *   for (const c of createSqlDatabaseConformance(() => ({ components: withWorkersHost(objectHost(), [storageDo]) })))
 *     it(`${c.group}: ${c.name}`, () => inObject(c));
 */

import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { WorkersHost } from "@pikit/contracts";
import type { ConformanceCase } from "@pikit/core/testing";
import { forgetComposition } from "../src/platform.ts";

/** The Worker's env as the entrypoint puts it in `WORKERS_HOST` (typed by `wrangler types`). */
export const workerEnv: WorkersHost["env"] = { ...env };

let current: WorkersHost | undefined;

/** The host of the object the running case is in. */
export function objectHost(): WorkersHost {
  if (current === undefined) throw new Error("workerd lane: objectHost() called outside inObject()");
  return current;
}

/** The host deployment-cloudflare builds for an object: its id, its storage, its hooks. */
export function hostOf(state: DurableObjectState): WorkersHost {
  return {
    env: workerEnv,
    object: { id: state.id.toString(), storage: state.storage, onAlarm: () => {}, onDeliver: () => {} },
  };
}

/** Runs `c` inside a new object, which no other case has touched. */
export function inObject(c: ConformanceCase | ((host: WorkersHost) => Promise<void>)): Promise<void> {
  const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => {
    current = hostOf(state);
    try {
      await (typeof c === "function" ? c(current) : c.run());
    } finally {
      current = undefined;
    }
  });
}

/**
 * After a test of `PlatformConversation` (`src/platform.ts`): forgets what its objects were composed of
 * and resets every object's instance (their storage stays), so the next event starts a new instance
 * that composes what is composed next. Resets, not evictions: an eviction waits for the object's last
 * reference to go, and a stub whose RPC rejected keeps one.
 */
export async function resetObjects(): Promise<void> {
  forgetComposition();
  await abortAllDurableObjects();
}
