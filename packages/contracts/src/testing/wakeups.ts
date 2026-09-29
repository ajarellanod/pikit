/**
 * `wakeups` conformance (SPEC §4.1, C3 and C4): what every provider of timers must do, wherever it
 * keeps its requests. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createWakeupsConformance(() => ({ components: [myWakeups] }), { backoffMs: MY_BACKOFF }))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite owns the clock (`createManualClock`), so times are checked to the millisecond without
 * waiting, and the handlers, which it scripts. How long a failed handler waits is the provider's
 * policy (SPEC §4.9): the provider declares it (`backoffMs`), and the suite holds it to that. So are
 * a slice deadline (`sliceMs`) and requests that survive a restart (`durable`): the cases that need
 * them run only when the options say the provider has them.
 *
 * A handler that asks again for its own name needs `wakeups`, and a component cannot both provide a
 * `wakeup` handler and use `wakeups` (a dependency cycle, see `wakeups.ts`). So the suite installs two
 * components of one module: one provides the handlers, the other uses `wakeups` and hands it to them.
 *
 * `createMemoryWakeups` is the in-memory double: it passes this suite, and it stands in for a provider
 * in the tests of a component that wakes.
 */

import {
  type App,
  type AppContext,
  BACKGROUND_CONTEXT,
  type ComponentDefinition,
  type Context,
  defineApp,
  defineComponent,
  silentLogger,
  withAbortSignal,
  withCancel,
} from "@pikit/core";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";
import type { Wakeups } from "../wakeups.ts";
import { checker, expecter } from "./assert.ts";

/** A provider over fresh, empty requests, built for one case. */
export interface WakeupsFixture {
  /**
   * The component providing `wakeups`, and what it uses. The suite may create several apps from them,
   * one after the other, as a process that restarts: what a durable provider keeps lives outside the
   * components' setup (a file, a map).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  dispose?(): Promise<void>;
}

export interface WakeupsConformanceOptions {
  /** The provider's waits after a handler's 1st, 2nd… consecutive failure, in ms; the last repeats. */
  backoffMs: readonly number[];
  /** The provider cancels a running handler's context this long after its run began (its slice). */
  sliceMs?: number;
  /** Requests survive a new app over the fixture's storage. */
  durable?: boolean;
}

const GROUP = "wakeups";
const expect = expecter(GROUP);
const check = checker(GROUP);

const HOUR = 60 * 60 * 1_000;
/** The handlers the suite provides. */
const A = "conformance.a";
const B = "conformance.b";

interface Run {
  name: string;
  /** When it began, in ms after the case began. */
  at: number;
  ctx: AppContext;
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );

/** A promise that resolves when `ctx` is cancelled. */
const cancelled = (ctx: Context): Promise<void> =>
  new Promise((resolve) => {
    const signal = ctx.abortSignal;
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

export function createWakeupsConformance(
  factory: () => WakeupsFixture | Promise<WakeupsFixture>,
  options: WakeupsConformanceOptions,
): readonly ConformanceCase[] {
  if (options.backoffMs.length === 0) throw new Error(`${GROUP}: backoffMs needs at least one wait`);
  const wait = (failures: number): number => options.backoffMs[Math.min(failures, options.backoffMs.length) - 1] as number;

  const wakeupsCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const subject = createSubject(fixture);
      try {
        await subject.open();
        await run(subject);
      } finally {
        await subject.close();
        await fixture.dispose?.();
      }
    },
  });

  const cases: ConformanceCase[] = [
    wakeupsCase("a handler runs once its time comes, never before, and once", async (s) => {
      await s.at(A, 1_000);
      await s.advance(999);
      expect(s.times(A), [], "runs before the time");
      await s.advance(1);
      expect(s.times(A), [1_000], "runs at the time");
      await s.advance(HOUR);
      expect(s.times(A), [1_000], "runs an hour later");
    }),

    wakeupsCase("a time already past runs at once", async (s) => {
      await s.at(A, -5_000);
      await s.advance(0);
      expect(s.times(A), [0], "runs");
    }),

    wakeupsCase("at replaces the name's request, with a later time or a sooner one", async (s) => {
      await s.at(A, 1_000);
      await s.at(A, 5_000);
      await s.advance(1_000);
      expect(s.times(A), [], "runs at the replaced time");
      await s.advance(4_000);
      expect(s.times(A), [5_000], "runs at the later time");

      await s.at(A, 10_000);
      await s.at(A, 6_000);
      await s.advance(1_000);
      expect(s.times(A), [5_000, 6_000], "runs at the sooner time");
      await s.advance(HOUR);
      expect(s.times(A), [5_000, 6_000], "runs after the replaced time");
    }),

    wakeupsCase("cancel drops the request; cancelling a name with no request changes nothing", async (s) => {
      await s.at(A, 1_000);
      await s.wakeups().cancel(A, s.ctx());
      await s.wakeups().cancel(B, s.ctx());
      await s.advance(HOUR);
      expect(s.runs, [], "runs");
    }),

    wakeupsCase("names are independent", async (s) => {
      await s.at(A, 1_000);
      await s.at(B, 2_000);
      await s.wakeups().cancel(A, s.ctx());
      await s.advance(2_000);
      expect(
        s.runs.map((r) => [r.name, r.at]),
        [[B, 2_000]],
        "runs",
      );
    }),

    wakeupsCase("at rejects, recording nothing, for a name no handler has (naming it) or a time that is not finite", async (s) => {
      const error = await rejection(s.at("conformance.nobody-handles-this", 0));
      check(error instanceof Error && error.message.includes("conformance.nobody-handles-this"), `an error naming the handler, got ${String(error)}`);
      check((await rejection(s.wakeups().at(A, Number.NaN, s.ctx()))) !== undefined, "at with NaN to reject");
      check((await rejection(s.wakeups().at(A, Number.POSITIVE_INFINITY, s.ctx()))) !== undefined, "at with Infinity to reject");
      await s.advance(HOUR);
      expect(s.runs, [], "runs");
    }),

    wakeupsCase("a handler that rejects runs again after each declared wait until it resolves, and a success resets the count", async (s) => {
      const failing = options.backoffMs.length + 1;
      let calls = 0;
      s.behave(A, async () => {
        if (++calls <= failing) throw new Error(`failure ${calls}`);
      });
      await s.at(A, 1_000);
      await s.advance(1_000);
      let expected = [1_000];
      for (let failures = 1; failures <= failing; failures++) {
        const next = (expected.at(-1) as number) + wait(failures);
        await s.advance(wait(failures) - 1);
        expect(s.times(A), expected, `runs 1 ms before the retry after failure ${failures}`);
        await s.advance(1);
        expected = [...expected, next];
        expect(s.times(A), expected, `runs at the retry after failure ${failures}`);
      }
      await s.advance(HOUR);
      expect(s.times(A).length, failing + 1, "runs after the handler resolved");

      // One more failure after a success waits the first wait again.
      s.behave(A, async () => {
        if (++calls === failing + 2) throw new Error("a new failure");
      });
      const again = s.now();
      await s.at(A, again);
      await s.advance(0);
      await s.advance(wait(1));
      expect(s.times(A).slice(-2), [again, again + wait(1)], "the run that failed and its retry");
    }),

    wakeupsCase("a handler continues by asking again for its own name, at once or later", async (s) => {
      let calls = 0;
      s.behave(A, async (run) => {
        calls++;
        if (calls === 1) await s.wakeups().at(A, run.ctx.clock.now(), run.ctx);
        if (calls === 2) await s.wakeups().at(A, run.ctx.clock.now() + 500, run.ctx);
      });
      await s.at(A, 0);
      await s.advance(0);
      expect(s.times(A), [0, 0], "the first run and the one it asked for at once");
      await s.advance(500);
      expect(s.times(A), [0, 0, 500], "the run the second asked for");
      await s.advance(HOUR);
      expect(s.times(A).length, 3, "runs once no run asked again");
    }),

    wakeupsCase("one run per name at a time: a request that comes due during a run waits for it to end", async (s) => {
      let running = 0;
      let most = 0;
      let release = () => {};
      s.behave(A, async () => {
        running++;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => (release = resolve));
        running--;
      });
      await s.at(A, 0);
      await s.advance(0);
      await s.at(A, s.now());
      await s.advance(1_000);
      expect(s.times(A), [0], "runs while the first has not ended");
      release();
      await s.advance(0);
      expect(s.times(A), [0, 1_000], "runs once the first ended");
      release();
      await s.advance(0);
      expect(most, 1, "runs of one name at the same time");
    }),

    wakeupsCase("a request made during a failed run stands when it is sooner than the retry; a cancel during it drops the retry", async (s) => {
      let calls = 0;
      s.behave(A, async (run) => {
        calls++;
        const now = run.ctx.clock.now();
        if (calls === 1) await s.wakeups().at(A, now, run.ctx);
        if (calls === 2) await s.wakeups().at(A, now + HOUR, run.ctx);
        if (calls === 3) await s.wakeups().cancel(A, run.ctx);
        if (calls <= 3) throw new Error(`failure ${calls}`);
      });
      await s.at(A, 0);
      await s.advance(0);
      expect(s.times(A), [0, 0], "the failed run and the sooner request it made");
      await s.advance(wait(2));
      expect(s.times(A), [0, 0, wait(2)], "the retry, sooner than the request the second run made");
      await s.advance(2 * HOUR);
      expect(s.times(A).length, 3, "runs after a run that cancelled its name failed");
    }),

    wakeupsCase("a handler's context is its own, not the context of whoever called at", async (s) => {
      const caller = withCancel(BACKGROUND_CONTEXT);
      await s.wakeups().at(A, s.now(), s.ctx(caller.context));
      caller.cancel(new Error("the caller went away"));
      await s.advance(0);
      const [run] = s.runs;
      check(run !== undefined, "the handler to run after its caller's context was cancelled");
      check(run?.ctx.abortSignal?.aborted !== true, "the handler's context not to be cancelled with its caller's");
    }),

    wakeupsCase("stopping the app cancels a running handler's context, and nothing runs after", async (s) => {
      let sawCancel = false;
      s.behave(A, async (run) => {
        await cancelled(run.ctx);
        sawCancel = true;
      });
      await s.at(A, 0);
      await s.at(B, 1_000);
      await s.advance(0);
      await s.stop();
      check(sawCancel, "the running handler's context to be cancelled by the stop");
      await s.advance(HOUR);
      expect(
        s.runs.map((r) => r.name),
        [A],
        "runs after the stop",
      );
    }),
  ];

  if (options.sliceMs !== undefined) {
    const sliceMs = options.sliceMs;
    cases.push(
      wakeupsCase("a running handler's context is cancelled at the slice deadline, and asking again continues at once", async (s) => {
        let cancelledAt: number | undefined;
        s.behave(A, async (run) => {
          if (s.times(A).length > 1) return;
          await cancelled(run.ctx);
          cancelledAt = s.now();
          await s.wakeups().at(A, run.ctx.clock.now(), run.ctx);
        });
        await s.at(A, 0);
        await s.advance(0);
        await s.advance(sliceMs - 1);
        expect(cancelledAt, undefined, "a cancellation before the deadline");
        await s.advance(1);
        expect(cancelledAt, sliceMs, "when the handler's context was cancelled");
        expect(s.times(A), [0, sliceMs], "the cut run and the one it asked for");
      }),
    );
  }

  if (options.durable) {
    cases.push(
      wakeupsCase("a request survives a restart and runs in the new process", async (s) => {
        await s.at(A, 1_000);
        await s.restart();
        await s.advance(1_000);
        expect(s.times(A), [1_000], "runs after the restart");
      }),
    );
  }

  return cases;
}

interface Subject {
  /** Every run, in the order they began. */
  runs: Run[];
  /** When `name` ran, in ms after the case began. */
  times(name: string): number[];
  /** What `name`'s handler does after its run is recorded; by default it resolves at once. */
  behave(name: string, handle: (run: Run) => Promise<void>): void;
  wakeups(): Wakeups;
  /** An app context, over `parent` when given. */
  ctx(parent?: Context): AppContext;
  /** Asks for `name` at `offset` ms after the case began. */
  at(name: string, offset: number): Promise<void>;
  /** Now, in ms after the case began. */
  now(): number;
  advance(ms: number): Promise<void>;
  open(): Promise<void>;
  /** Stops the app, as a process that exits. */
  stop(): Promise<void>;
  /** Stops the app and starts a new one over the same fixture, on the same clock. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

function createSubject(fixture: WakeupsFixture): Subject {
  const clock: ManualClock = createManualClock();
  const start = clock.now();
  const runs: Run[] = [];
  const behaviours = new Map<string, (run: Run) => Promise<void>>();
  let app: App | undefined;
  let wakeups: Wakeups | undefined;

  // Two components of one module: the handlers, and the one using `wakeups` that hands it to them.
  const handler = (name: string) => async (ctx: AppContext) => {
    const run = { name, at: clock.now() - start, ctx };
    runs.push(run);
    await (behaviours.get(name) ?? (async () => {}))(run);
  };
  const handlers = defineComponent({
    name: "wakeups-conformance-handlers",
    setup(pikit) {
      pikit.provideKeyed("wakeup", A, handler(A));
      pikit.provideKeyed("wakeup", B, handler(B));
    },
  });
  const client = defineComponent({
    name: "wakeups-conformance-client",
    setup(pikit) {
      const handle = pikit.use("wakeups");
      return { start: () => void (wakeups = handle.get()) };
    },
  });

  const subject: Subject = {
    runs,
    times: (name) => runs.filter((r) => r.name === name).map((r) => r.at),
    behave: (name, handle) => void behaviours.set(name, handle),
    wakeups() {
      if (wakeups === undefined) throw new Error(`${GROUP}: wakeups was not resolved`);
      return wakeups;
    },
    ctx(parent) {
      if (app === undefined) throw new Error(`${GROUP}: no app is running`);
      return app.context(parent);
    },
    at: (name, offset) => subject.wakeups().at(name, start + offset, subject.ctx()),
    now: () => clock.now() - start,
    advance: (ms) => clock.advance(ms),
    async open() {
      wakeups = undefined;
      app = await defineApp({
        components: [handlers, ...fixture.components, client],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
        clock,
      }).create();
      await app.start();
    },
    async stop() {
      await app?.stop(withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT));
    },
    async restart() {
      await subject.stop();
      await subject.open();
    },
    async close() {
      await app?.stop().catch(() => {});
    },
  };
  return subject;
}

/**
 * `wakeups` in memory, for tests: requests live as long as the app, and run on the app's clock (a
 * manual clock's `advance` runs what comes due). A handler that rejects runs again after `retryMs`
 * (1 s by default), every time. It has no slice deadline, and nothing survives a restart.
 */
export function createMemoryWakeups(options: { retryMs?: number } = {}): ComponentDefinition {
  const retryMs = options.retryMs ?? 1_000;
  return defineComponent({
    name: "memory-wakeups",
    setup(pikit) {
      const handlers = pikit.useKeyed("wakeup");
      const clock = pikit.clock;
      const requests = new Map<string, number>();
      /** The runs in progress, by name; `touched` once `at` or `cancel` was called during the run. */
      const runs = new Map<string, { touched: boolean; done: Promise<void> }>();
      let stopping: AbortController | undefined;
      let loop: Promise<void> | undefined;

      let wake = () => {};
      let woken = new Promise<void>((resolve) => (wake = resolve));
      const kick = () => {
        wake();
        woken = new Promise<void>((resolve) => (wake = resolve));
      };

      const begin = (name: string, ctx: AppContext) => {
        requests.delete(name);
        const run = { touched: false, done: Promise.resolve() };
        runs.set(name, run);
        run.done = Promise.resolve()
          .then(() => (handlers.get(name) as (ctx: AppContext) => Promise<void>)(ctx))
          .then(
            () => {},
            () => {
              const retry = clock.now() + retryMs;
              const asked = requests.get(name);
              if (!run.touched) requests.set(name, retry);
              else if (asked !== undefined) requests.set(name, Math.min(asked, retry));
            },
          )
          .finally(() => {
            runs.delete(name);
            kick();
          });
      };

      pikit.provide("wakeups", {
        async at(name, time) {
          if (handlers.get(name) === undefined) throw new Error(`memory-wakeups: no "wakeup" handler is named "${name}"`);
          if (!Number.isFinite(time)) throw new TypeError(`memory-wakeups: the time for "${name}" must be a finite number, got ${time}`);
          requests.set(name, time);
          const run = runs.get(name);
          if (run !== undefined) run.touched = true;
          kick();
        },
        async cancel(name) {
          requests.delete(name);
          const run = runs.get(name);
          if (run !== undefined) run.touched = true;
          kick();
        },
      });

      return {
        start(ctx) {
          stopping = new AbortController();
          const signal = stopping.signal;
          // The start context's values, cancelled only when the app stops.
          const running = ctx.derive((inner) => ({ abortSignal: signal, value: (key) => inner.value(key), toString: () => `${inner}.Wakeup` }));
          loop = (async () => {
            while (!signal.aborted) {
              const changed = woken;
              const now = clock.now();
              let next = now + 1_000;
              for (const [name, time] of requests) {
                if (runs.has(name)) continue;
                if (time <= now) begin(name, running);
                else next = Math.min(next, time);
              }
              await Promise.race([changed, clock.sleep(next - now)]);
            }
          })();
        },
        async stop() {
          stopping?.abort(new Error("memory-wakeups: the app is stopping"));
          kick();
          await loop;
          await Promise.all([...runs.values()].map((run) => run.done));
        },
      };
    },
  });
}
