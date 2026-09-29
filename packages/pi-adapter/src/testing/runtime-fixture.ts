/**
 * The `agent.runtime` conformance fixture on Pi, whatever keeps its records. The records (where
 * sessions live, and how a worker dies mid-run) are the caller's: `createPiRuntimeFixture` keeps them
 * in a temporary directory and kills a real process; the workerd lane keeps them in a Durable Object
 * and abandons a run in the object (`interruptInProcess`). Neutral: it imports no runtime module.
 *
 * The runtime under test is built by the caller, so the same fixture checks the adapter and the
 * `runtime-pi` component. The fixture provides what it uses: the scripted `agent.definition` and the
 * `faux` `model.provider`; the records provide `sessions.store`.
 */

import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type AppContext, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentDefinition, ConversationRef } from "@pikit/contracts";
import type { AgentRuntimeFixture } from "@pikit/contracts/testing";
import type { HarnessHook } from "../conversation.ts";
import { modelsFrom } from "../models.ts";
import { createPiRuntime } from "../runtime.ts";
import type { SessionStore } from "../types.ts";
import { holdTool, scriptedAgent, scriptedProvider, type ScriptedProviderOptions } from "./script.ts";

export interface PiRuntimeUnderTest {
  /** Pass to the runtime: the fixture pauses runs at their end through Pi's `before_run_end` hook. */
  onHarness: HarnessHook;
}

/** Where a runtime fixture keeps what outlives a worker. */
export interface RuntimeFixtureRecords {
  /** Given to every worker: they provide `sessions.store` (and whatever it needs). */
  components: ComponentDefinition[];
  /** A new session in the records, closed again; its id. */
  createSession(): Promise<string>;
  /**
   * Leaves `sessionId` with an open run of the scripted agent's `hold` (request `requestId`, tool
   * replay `"never"`) that no worker drives, as a worker that died mid-run leaves it.
   */
  interrupt(sessionId: string, requestId: string): Promise<void>;
  /** Release what the records hold (a directory, a database). */
  dispose?(): Promise<void>;
}

export function createRuntimeFixture(runtime: (underTest: PiRuntimeUnderTest) => ComponentDefinition[], records: RuntimeFixtureRecords): AgentRuntimeFixture {
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
    // After the final answer, before Pi commits the run's end: the window of gap 2 in `pi-gaps.test.ts`.
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

  let failing: { reach(): void; released: Promise<void> } | undefined;
  const fail = (): Promise<string> | undefined => {
    const armed = failing;
    if (armed === undefined) return undefined;
    failing = undefined;
    armed.reach();
    return armed.released.then(() => "scripted failure");
  };

  const agent = scriptedAgent(hold);
  const support = testComponents({ agents: [agent], fail });

  const conversation = async (): Promise<ConversationRef> => {
    const sessionId = await records.createSession();
    return { key: `test:pi:${sessionId}`, agent: agent.name, sessionId };
  };

  return {
    components: [...records.components, support.agents, support.provider, ...runtime({ onHarness })],
    conversation,
    hold: { started: holdStarted, release: () => release() },
    holdAtEnd() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      end = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    failNext() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      failing = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    async interrupted() {
      const ref = await conversation();
      const requestId = "r-crashed";
      await records.interrupt(ref.sessionId, requestId);
      return { conversation: ref, requestId };
    },
    dispose: async () => records.dispose?.(),
  };
}

/**
 * A worker that dies mid-run, inside this process: it dispatches `hold` to the scripted agent's
 * conversation `sessionId` over `sessions`, and once the tool runs, abandons the run. It is never
 * stopped, and its tool never returns, so what it leaves is what a killed process or a reset Durable
 * Object leaves: the request committed, the tool call's intent recorded, the run open. For runtimes
 * with no processes to kill (workerd); `killMidRun` kills a real one.
 */
export async function interruptInProcess(sessions: SessionStore, sessionId: string, requestId: string, replay: "safe" | "never" = "never"): Promise<void> {
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  const agent = scriptedAgent(
    holdTool(() => {
      held();
      return new Promise<string>(() => {});
    }, replay),
  );
  const ctx: AppContext = (await defineApp({ components: [], logger: silentLogger }).create()).context();
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: ctx,
  });
  await runtime.dispatch({ requestId, conversation: { key: `test:pi:${sessionId}`, agent: agent.name, sessionId }, prompt: "hold" }, ctx);
  await reached;
}

/** What a runtime uses, for tests: `sessions.store`, `agent.definition` and the `faux` provider. */
export interface TestComponents {
  sessions: ComponentDefinition;
  agents: ComponentDefinition;
  provider: ComponentDefinition;
}

/**
 * Test providers of what `agent.runtime` uses. Sessions default to Pi's in-memory repo, agents to
 * the scripted one (whose `hold` returns at once); the provider is `faux`, model `faux/scripted`.
 */
export function testComponents(
  options: { sessions?: SessionStore; agents?: AgentDefinition[]; fail?: ScriptedProviderOptions["fail"] } = {},
): TestComponents {
  const sessions = options.sessions ?? new MemorySessionRepo();
  const agents = options.agents ?? [scriptedAgent(holdTool(async () => "released"))];
  const provider = scriptedProvider(options.fail !== undefined ? { fail: options.fail } : {});
  return {
    sessions: defineComponent({ name: "sessions-fixture", setup: (pikit) => pikit.provide("sessions.store", sessions) }),
    agents: defineComponent({
      name: "agents-fixture",
      setup(pikit) {
        for (const agent of agents) pikit.provideKeyed("agent.definition", agent.name, agent);
      },
    }),
    provider: defineComponent({
      name: "provider-faux",
      setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider),
    }),
  };
}
