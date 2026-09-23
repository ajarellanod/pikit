/**
 * The `agent.runtime` conformance fixture on Pi. Sessions are JSONL files in a temporary
 * directory, so they outlive a worker as a real store does, and `interrupted()` kills a real
 * process mid-run (SIGKILL) for the next worker to resume.
 *
 * The runtime under test is built by the caller, so the same fixture checks the adapter and the
 * `runtime-pi` component. The fixture provides what it uses: `sessions.store`, the scripted
 * `agent.definition` and the `faux` `model.provider`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT, type ComponentDefinition, type ConversationRef, defineComponent } from "@pikit/core";
import type { AgentRuntimeFixture } from "@pikit/core/testing";
import type { HarnessHook } from "../conversation.ts";
import { holdTool, scriptedAgent, scriptedProvider } from "./script.ts";

export interface PiRuntimeUnderTest {
  /** Pass to the runtime: the fixture pauses runs at their end through Pi's `before_run_end` hook. */
  onHarness: HarnessHook;
}

const WORKER = fileURLToPath(new URL("./interrupted-worker.ts", import.meta.url));

export function createPiRuntimeFixture(runtime: (underTest: PiRuntimeUnderTest) => ComponentDefinition[]): AgentRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "pikit-pi-"));
  const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holdStarted = new Promise<void>((resolve) => (started = resolve));
  const hold = holdTool(async (context) => {
    started();
    const signal = context.abortSignal;
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void released.then(resolve);
    });
    return "released";
  });

  let end: { reach(): void; released: Promise<void> } | undefined;
  const onHarness: HarnessHook = (harness) => {
    // After the final answer, before Pi commits the run's end: the window of SPEC §6.4, gap 2.
    harness.hooks.on("before_run_end", async () => {
      const paused = end;
      end = undefined;
      if (paused !== undefined) {
        paused.reach();
        await paused.released;
      }
      return undefined;
    });
  };

  const agent = scriptedAgent(hold);
  const provider = scriptedProvider();
  const records = [
    defineComponent({ name: "sessions-fixture", setup: (pikit) => pikit.provide("sessions.store", sessions) }),
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];

  const conversation = async (): Promise<ConversationRef> => {
    const session = await sessions.create({ cwd: root }, BACKGROUND_CONTEXT);
    // The runtime opens it again from the store: one open Session per process at a time.
    await session.close(BACKGROUND_CONTEXT);
    return { key: `test:pi:${session.metadata.id}`, agent: agent.name, sessionId: session.metadata.id };
  };

  return {
    components: [...records, ...runtime({ onHarness })],
    conversation,
    hold: { started: holdStarted, release: () => release() },
    holdAtEnd() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      end = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    async interrupted() {
      const ref = await conversation();
      const requestId = "r-crashed";
      await killMidRun(root, ref.sessionId, requestId, "never");
      return { conversation: ref, requestId };
    },
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Run `hold` in a separate process over the sessions in `root`, and SIGKILL it once the tool runs.
 * The session is left with an open run whose tool call has no result.
 */
export async function killMidRun(root: string, sessionId: string, requestId: string, replay: "safe" | "never"): Promise<void> {
  const worker = spawn(process.execPath, [WORKER, root, sessionId, requestId, replay], { stdio: ["ignore", "pipe", "inherit"] });
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
