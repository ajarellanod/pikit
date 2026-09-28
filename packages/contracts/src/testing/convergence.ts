/**
 * Convergence (SPEC §4.8, §14): kill the process after each of its commits in turn, start a new one
 * over the same records, and check that it ends where it should. Runner-independent, like the
 * lifecycle suite:
 *
 *   for (const c of createConvergenceConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * Only a component that reacts through records passes it: a producer that records facts in the same
 * commit as the change they describe, a consumer that reads them with its own cursor and applies them
 * idempotently. One that reacts to events alone fails it: an event lost with its process is lost
 * for good. The suite's own test proves both.
 *
 * How a crash is simulated, in process: the suite gives the components their `storage.sql`, a
 * wrapper over the fixture's database that counts commits (each `run`, each `transaction`). Crash
 * point `k` lets `k` commits through; at the next one the process is dead: that commit and every
 * later call reject, `dead` turns true and `signal` aborts, so the fixture's fakes of the outside
 * world stop answering it. Between commit `k` and its death the process ran on, as a real one does:
 * a send made after a commit and lost before the next is the case where duplicates come from.
 * A test that needs a real SIGKILL keeps its own (`outbound-durable`'s `crash.test.ts`).
 *
 * The new process gets the same records, the world repeats the scenario (it retries what went
 * unacknowledged, as platforms and users do), and the invariant must hold.
 */

import { type App, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withAbortSignal } from "@pikit/core";
import type { SqlDatabase } from "../storage.ts";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";

/** One process, as its components see it. */
export interface ProcessLife {
  /** True once this process has crashed. */
  readonly dead: boolean;
  /** Aborted when this process crashes: waits in the scenario stop. */
  readonly signal: AbortSignal;
}

/** One process, as the scenario and the invariant see it. */
export interface ConvergenceProcess extends ProcessLife {
  readonly app: App;
  /** Shared by every process of a case: time goes on across a crash. */
  readonly clock: ManualClock;
}

/** Fresh records and the components that use them, built for one run of the scenario. */
export interface ConvergenceFixture {
  /** The records every process of the run shares: they outlive each crash. Fresh and empty. */
  database: SqlDatabase;
  /** The components of one process, `storage.sql` excepted: the suite provides it over `database`. */
  components(life: ProcessLife): ComponentDefinition[];
  config?: Record<string, unknown>;
  /**
   * What the outside world does: messages arrive, transports answer. Resolves once its effects are
   * visible. Run on the first process, and again on the one after a crash, so it must be what a
   * world that retries would do twice.
   */
  scenario(process: ConvergenceProcess): Promise<void>;
  /** Throws when the records are not what the scenario should have left. */
  invariant(process: ConvergenceProcess): Promise<void>;
  dispose?(): Promise<void>;
}

const GROUP = "convergence";

/** What a dead process's storage answers. */
export class SimulatedCrash extends Error {
  constructor() {
    super("convergence: the process crashed here (simulated)");
    this.name = "SimulatedCrash";
  }
}

export function createConvergenceConformance(factory: () => ConvergenceFixture | Promise<ConvergenceFixture>): readonly ConformanceCase[] {
  return [
    {
      group: GROUP,
      name: "with no crash, the scenario leaves what the invariant expects",
      run: async () => {
        await runOnce(factory, undefined);
      },
    },
    {
      group: GROUP,
      name: "the world repeating the scenario on the next process changes nothing",
      run: async () => {
        // A crash point past the last commit: the first process runs everything, then stops.
        await runOnce(factory, Number.POSITIVE_INFINITY);
      },
    },
    {
      group: GROUP,
      name: "a crash after any commit converges on the next process",
      run: async () => {
        const commits = await runOnce(factory, undefined);
        for (let k = 0; k <= commits; k++) {
          try {
            await runOnce(factory, k);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${GROUP}: after a crash at commit ${k} of ${commits}: ${message}`, { cause: error });
          }
        }
      },
    },
  ];
}

/**
 * One run over fresh records. `crashAt` undefined: one process, then the invariant. A number: the
 * first process dies at that commit (or runs to the end when it makes fewer), a second process takes
 * over, the world repeats the scenario, then the invariant. Returns the first process's commits.
 */
async function runOnce(factory: () => ConvergenceFixture | Promise<ConvergenceFixture>, crashAt: number | undefined): Promise<number> {
  const fixture = await factory();
  const clock = createManualClock();
  const apps: App[] = [];
  try {
    const first = crashingStorage(fixture.database, crashAt ?? Number.POSITIVE_INFINITY);
    const one = await openProcess(fixture, first, clock, apps);
    try {
      await untilDeath(first, async () => {
        await one.app.start();
        await fixture.scenario(one);
      });
    } catch (error) {
      if (!first.dead) throw error;
    }
    if (crashAt === undefined) {
      if (first.dead) throw new Error(`${GROUP}: the process died with no crash point`);
      await fixture.invariant(one);
      return first.commits;
    }

    // The first process is gone: its storage refuses everything, and it stops with no time to finish.
    first.kill();
    await one.app.stop(withAbortSignal(AbortSignal.abort(new SimulatedCrash()), BACKGROUND_CONTEXT)).catch(() => {});

    const second = crashingStorage(fixture.database, Number.POSITIVE_INFINITY);
    const two = await openProcess(fixture, second, clock, apps);
    await two.app.start();
    await fixture.scenario(two);
    await fixture.invariant(two);
    return first.commits;
  } finally {
    for (const app of apps) await app.stop().catch(() => {});
    await fixture.dispose?.();
  }
}

interface CrashingStorage extends ProcessLife {
  readonly database: SqlDatabase;
  /** Commits that went through. */
  readonly commits: number;
  /** Resolves when the process dies. */
  readonly died: Promise<void>;
  /** Kills the process now. */
  kill(): void;
}

/**
 * `database`, one call at a time, for a process that dies at commit `crashAt`: `crashAt` commits go
 * through, the next one and every later call reject with `SimulatedCrash`.
 */
function crashingStorage(database: SqlDatabase, crashAt: number): CrashingStorage {
  const controller = new AbortController();
  let commits = 0;
  let dead = false;
  let died!: () => void;
  const diedPromise = new Promise<void>((resolve) => (died = resolve));
  const kill = () => {
    if (dead) return;
    dead = true;
    controller.abort(new SimulatedCrash());
    died();
  };
  // One call at a time, so the count of commits is the order they happened in.
  let line: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(() => {
      if (dead) throw new SimulatedCrash();
      return work();
    });
    line = next.catch(() => {});
    return next;
  };
  const commit = <T>(work: () => Promise<T>): Promise<T> =>
    serial(async () => {
      if (commits >= crashAt) {
        kill();
        throw new SimulatedCrash();
      }
      const result = await work();
      commits += 1;
      return result;
    });
  const wrapped: SqlDatabase = {
    query: (sql, params) => serial(() => database.query(sql, params)),
    run: (sql, params) => commit(() => database.run(sql, params)),
    transaction: (work) => commit(() => database.transaction(work)),
  };
  return {
    database: wrapped,
    get commits() {
      return commits;
    },
    get dead() {
      return dead;
    },
    signal: controller.signal,
    died: diedPromise,
    kill,
  };
}

async function openProcess(fixture: ConvergenceFixture, storage: CrashingStorage, clock: ManualClock, apps: App[]): Promise<ConvergenceProcess> {
  const provider = defineComponent({
    name: "convergence-storage",
    setup: (pikit) => pikit.provide("storage.sql", storage.database),
  });
  const life: ProcessLife = {
    get dead() {
      return storage.dead;
    },
    signal: storage.signal,
  };
  const app = await defineApp({
    components: [provider, ...fixture.components(life)],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger: silentLogger,
    clock,
  }).create();
  apps.push(app);
  return {
    app,
    clock,
    signal: storage.signal,
    get dead() {
      return storage.dead;
    },
  };
}

/** Runs `work` until it ends or the process dies, whichever comes first. */
async function untilDeath(storage: CrashingStorage, work: () => Promise<void>): Promise<void> {
  const running = work();
  // What the dead process was still doing fails on its own; nobody waits for it.
  running.catch(() => {});
  await Promise.race([running, storage.died.then(() => Promise.reject(new SimulatedCrash()))]);
}
