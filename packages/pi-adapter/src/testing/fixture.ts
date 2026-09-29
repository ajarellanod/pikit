/**
 * The `agent.runtime` conformance fixture on Pi, on a server. Sessions are in a temporary directory
 * (Pi's JSONL files, or the SQL store on a SQLite file: `sessions`), so they outlive a worker as a
 * real store does, and `interrupted()` kills a real process mid-run (SIGKILL) for the next worker to
 * resume. The fixture itself is `createRuntimeFixture` (`runtime-fixture.ts`, neutral); this file
 * gives it records on disk and a process to kill.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type ComponentDefinition, defineComponent } from "@pikit/core";
import type { AgentRuntimeFixture } from "@pikit/contracts/testing";
import { createRuntimeFixture, type PiRuntimeUnderTest } from "./runtime-fixture.ts";
import { type SessionsKind, sessionsAt } from "./stores.ts";

const WORKER = fileURLToPath(new URL("./interrupted-worker.ts", import.meta.url));

export interface PiRuntimeFixtureOptions {
  /**
   * Where sessions live: Pi's JSONL files (the default), or `@pikit/pi-adapter/sql`'s store on a
   * SQLite file held to a Durable Object's limits (what `sessions-sql` provides). Killed workers use
   * the same.
   */
  sessions?: SessionsKind;
}

export function createPiRuntimeFixture(
  runtime: (underTest: PiRuntimeUnderTest) => ComponentDefinition[],
  options: PiRuntimeFixtureOptions = {},
): AgentRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "pikit-pi-"));
  const kind = options.sessions ?? "jsonl";
  const store = sessionsAt(root, kind);
  const sessions = store.store;

  return createRuntimeFixture(runtime, {
    // The store is usable once its tables exist: what uses it starts after them.
    components: [
      defineComponent({
        name: "sessions-fixture",
        setup(pikit) {
          pikit.provide("sessions.store", sessions);
          return { start: () => store.ready };
        },
      }),
    ],
    async createSession() {
      await store.ready;
      const session = await sessions.create({ cwd: root }, BACKGROUND_CONTEXT);
      // The runtime opens it again from the store: one open Session per process at a time.
      await session.close(BACKGROUND_CONTEXT);
      return session.metadata.id;
    },
    interrupt: (sessionId, requestId) => killMidRun(root, sessionId, requestId, "never", kind),
    async dispose() {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
}

/**
 * Run `hold` in a separate process over the sessions in `root` (JSONL files by default, or the SQL
 * store's database there), and SIGKILL it once the tool runs. The session is left with an open run
 * whose tool call has no result.
 */
export async function killMidRun(root: string, sessionId: string, requestId: string, replay: "safe" | "never", sessions: SessionsKind = "jsonl"): Promise<void> {
  const worker = spawn(process.execPath, [WORKER, root, sessionId, requestId, replay, sessions], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  let held = false;
  for await (const line of createInterface({ input: worker.stdout })) {
    if (line === "held") {
      held = true;
      break;
    }
  }
  worker.kill("SIGKILL");
  await exited;
  if (!held) throw new Error("the interrupted worker died before its run reached the tool");
}
