/**
 * Lifecycle conformance (SPEC §4.6, §14): does a component honour `ctx.abortSignal`?
 *
 * The app stops waiting for a hook that outlives its deadline, but JavaScript cannot stop
 * the hook: a component that ignores the abort keeps running and may acquire resources nobody
 * will release. These cases abort the component's own `start` and `stop` while they run, then
 * check that the hook settles promptly, that nothing is left open (when the fixture can count
 * it), and that a fresh app over the same component can start again (a restart: apps
 * are single-use, so a restart is `create()` again, as on every target).
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
import { silentLogger } from "../contracts/logger.ts";
import { type ComponentDefinition, type ComponentLifecycle, defineApp, type App } from "../app.ts";

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
      await s.app.start();
      await s.app.stop();
      await s.expectNothingOpen("after stop");
    }),

    lifecycleCase("an aborted start settles promptly and leaves nothing open", async (s) => {
      const started = await s.app.start(s.abortDuring("start")).then(
        () => true,
        () => false,
      );
      await s.expectSettled("start");
      // The abort landed after start finished: the component is legitimately up.
      if (started) await s.app.stop();
      await s.expectNothingOpen("after an aborted start");
      await s.expectRestart();
    }),

    lifecycleCase("an aborted stop settles promptly and leaves nothing open", async (s) => {
      await s.app.start();
      await s.app.stop(s.abortDuring("stop")).catch(() => {});
      await s.expectSettled("stop");
      await s.expectNothingOpen("after an aborted stop");
      await s.expectRestart();
    }),
  ];
}

interface Subject {
  app: App;
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

  // Hooks still running, observed directly: the app stops waiting at the abort, the hook
  // does not, so a count above zero once the app returned is abandoned work.
  let running = 0;
  const tracked = (result: unknown): unknown => {
    if (!isThenable(result)) return result;
    running++;
    const settled = () => {
      running--;
    };
    result.then(settled, settled);
    return result;
  };

  const component: ComponentDefinition = {
    ...fixture.component,
    setup(pikit, config) {
      const hooks = fixture.component.setup(pikit, config);
      // A thenable is returned as is, so the app still rejects an async setup.
      if (!hooks || isThenable(hooks)) return hooks;
      return observe(hooks, invoked, tracked);
    },
  };
  const definition = defineApp({
    components: [...(fixture.providers ?? []), component],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger: silentLogger,
  });
  const app = await definition.create();

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
    app,
    abortDuring(hook) {
      const controller = new AbortController();
      armed = { hook, controller };
      return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    },
    async expectSettled(hook) {
      const deadline = Date.now() + settleMs;
      while (running > 0) {
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
      const fresh = await definition.create();
      await fresh.start();
      await fresh.stop();
      await expectNothingOpen("after a restart");
    },
  };
}

/**
 * The same hooks, reporting each invocation (after the call, so the hook is running) and
 * passing each result through `track` so the subject knows when it settles.
 */
function observe(
  hooks: ComponentLifecycle,
  invoked: (hook: Hook) => void,
  track: (result: unknown) => unknown,
): ComponentLifecycle {
  const observed: ComponentLifecycle = {};
  const { start, stop } = hooks;
  if (start) {
    observed.start = (ctx) => {
      const result = track(start.call(hooks, ctx)) as ReturnType<typeof start>;
      invoked("start");
      return result;
    };
  }
  if (stop) {
    observed.stop = (ctx) => {
      const result = track(stop.call(hooks, ctx)) as ReturnType<typeof stop>;
      invoked("stop");
      return result;
    };
  }
  return observed;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
