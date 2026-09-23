/**
 * Lifecycle conformance (SPEC §4.6, §14): does a component honour `ctx.abortSignal`?
 *
 * The harness stops waiting for a hook that outlives its deadline, but JavaScript cannot stop
 * the hook: a component that ignores the abort keeps running and may acquire resources nobody
 * will release. These cases abort the component's own `start` and `stop` while they run, then
 * check that the hook settles promptly, that nothing is left open (when the fixture can count
 * it), and that the harness can start again.
 *
 * Runner-independent, like Pi's session conformance. Register the cases with any framework:
 *
 *   for (const c of createLifecycleConformance(() => ({ component: myComponent })))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * A hook that finishes before the abort lands (synchronous, or faster than one event-loop turn)
 * passes trivially: there was nothing to abandon.
 */

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../context.ts";
import type { Logger } from "../contracts/logger.ts";
import {
  ABANDONED_MESSAGE,
  type ComponentDefinition,
  type ComponentLifecycle,
  defineHarness,
  type Harness,
  SETTLED_MESSAGE,
} from "../harness.ts";

/** One runner-independent case. Same shape as Pi's `ConformanceCase`. `run` throws on failure. */
export interface ConformanceCase {
  readonly group: string;
  readonly name: string;
  run(): Promise<void>;
}

/** A fresh component under test, built for one case. */
export interface LifecycleFixture {
  component: ComponentDefinition;
  /** Components providing what `component` uses. Fakes are fine; they are not under test. */
  providers?: ComponentDefinition[];
  config?: Record<string, unknown>;
  /**
   * Resources the component holds right now (sockets, timers, handles). When present it must
   * be 0 after an aborted start, after an aborted stop and after a normal stop. Without it the
   * cases can only check that hooks settle.
   */
  openResources?(): number | Promise<number>;
}

export interface LifecycleConformanceOptions {
  /** How long an aborted hook may take to settle. Default 1000 ms. */
  settleMs?: number;
}

type Hook = "start" | "stop";

export function createLifecycleConformance(
  factory: () => LifecycleFixture | Promise<LifecycleFixture>,
  options: LifecycleConformanceOptions = {},
): readonly ConformanceCase[] {
  const settleMs = options.settleMs ?? 1000;
  const lifecycleCase = (name: string, run: (subject: Subject) => Promise<void>): ConformanceCase => ({
    group: "lifecycle",
    name,
    run: async () => run(await createSubject(await factory(), settleMs)),
  });

  return [
    lifecycleCase("starts and stops, leaving nothing open", async (s) => {
      await s.harness.start();
      await s.harness.stop();
      await s.expectNothingOpen("after stop");
    }),

    lifecycleCase("an aborted start settles promptly and leaves nothing open", async (s) => {
      const started = await s.harness.start(s.abortDuring("start")).then(
        () => true,
        () => false,
      );
      await s.expectSettled("start");
      // The abort landed after start finished: the component is legitimately up.
      if (started) await s.harness.stop();
      await s.expectNothingOpen("after an aborted start");
      await s.expectRestart();
    }),

    lifecycleCase("an aborted stop settles promptly and leaves nothing open", async (s) => {
      await s.harness.start();
      await s.harness.stop(s.abortDuring("stop")).catch(() => {});
      await s.expectSettled("stop");
      await s.expectNothingOpen("after an aborted stop");
      await s.expectRestart();
    }),
  ];
}

interface Subject {
  harness: Harness;
  /** A context that aborts one event-loop turn after the component's `hook` is invoked. */
  abortDuring(hook: Hook): Context;
  expectSettled(hook: Hook): Promise<void>;
  expectNothingOpen(when: string): Promise<void>;
  expectRestart(): Promise<void>;
}

async function createSubject(fixture: LifecycleFixture, settleMs: number): Promise<Subject> {
  const name = fixture.component.name;
  let armed: { hook: Hook; controller: AbortController } | undefined;
  const invoked = (hook: Hook): void => {
    const trigger = armed;
    if (trigger?.hook !== hook) return;
    armed = undefined;
    setTimeout(() => trigger.controller.abort(new Error(`conformance: ${name}.${hook} aborted while running`)), 0);
  };

  // Abandoned work is observed through the harness's own log: abandoned minus settled.
  let outstanding = 0;
  const logger: Logger = {
    debug: () => {},
    info: (message) => {
      if (message === SETTLED_MESSAGE) outstanding--;
    },
    warn: (message) => {
      if (message === ABANDONED_MESSAGE) outstanding++;
    },
    error: () => {},
  };

  const component: ComponentDefinition = {
    ...fixture.component,
    setup(pikit, config) {
      const hooks = fixture.component.setup(pikit, config);
      // A thenable is returned as is, so the harness still rejects an async setup.
      if (!hooks || typeof (hooks as { then?: unknown }).then === "function") return hooks;
      return observe(hooks, invoked);
    },
  };
  const harness = await defineHarness({
    components: [...(fixture.providers ?? []), component],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger,
  }).create();

  const expectNothingOpen = async (when: string): Promise<void> => {
    if (!fixture.openResources) return;
    const open = await fixture.openResources();
    if (open !== 0) {
      throw new Error(
        `component "${name}": ${open} resource(s) still open ${when}; ` +
          "a hook that sees ctx.abortSignal must release what it acquired",
      );
    }
  };

  return {
    harness,
    abortDuring(hook) {
      const controller = new AbortController();
      armed = { hook, controller };
      return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    },
    async expectSettled(hook) {
      const deadline = Date.now() + settleMs;
      while (outstanding > 0) {
        if (Date.now() >= deadline) {
          throw new Error(
            `component "${name}": ${hook} was still running ${settleMs} ms after its abort; ` +
              "it must return promptly when ctx.abortSignal fires",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    expectNothingOpen,
    async expectRestart() {
      await harness.start();
      await harness.stop();
      await expectNothingOpen("after a restart");
    },
  };
}

/** The same hooks, reporting each invocation (after the call, so the hook is running). */
function observe(hooks: ComponentLifecycle, invoked: (hook: Hook) => void): ComponentLifecycle {
  const observed: ComponentLifecycle = {};
  const { start, stop } = hooks;
  if (start) {
    observed.start = (ctx) => {
      const result = start.call(hooks, ctx);
      invoked("start");
      return result;
    };
  }
  if (stop) {
    observed.stop = (ctx) => {
      const result = stop.call(hooks, ctx);
      invoked("stop");
      return result;
    };
  }
  return observed;
}
