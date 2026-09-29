/**
 * Convergence (SPEC K3): kill the process after each of its commits in turn, start a new one
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
 * How a cut is simulated, in process: the suite gives the components their `storage.sql`, a
 * wrapper over the fixture's database that counts commits (each `run`, each `transaction`). A dead
 * process's commit and every later call reject with `SimulatedCrash`, `dead` turns true and
 * `signal` aborts, so the fixture's fakes of the outside world stop answering it. Three cuts, each
 * at every commit in turn:
 *
 * - **Death at the next commit.** `k` commits go through; the process dies when it attempts the
 *   next. Between commit `k` and its death it ran on, as a real one does: its effects after commit
 *   `k` happened, and their outcome is lost. Duplicates come from here.
 * - **Death the instant a commit lands.** Commit `k` is durable, and the process dies before its
 *   caller continues: the commit's promise rejects with `SimulatedCrash`. Nothing after commit `k`
 *   happened. Lost work comes from here: a "claimed" row whose effect never ran.
 * - **A storage failure the process survives.** Commit `k` rejects with `SimulatedStorageFailure`
 *   and leaves the records as they were; later commits go through and the process runs on. The
 *   world repeats the scenario on the same process, up to `WORLD_RETRIES` times, moving the clock
 *   by `retryAfterMs` before each, and the invariant must hold by the last. A failure during start
 *   fails the start: the process exits and a supervisor starts a new one.
 *
 * Together the first two cover a death at either end of each stretch between two commits: before
 * any of its effects, and after all of them. A death between two effects of the same stretch is not
 * cut here: a fixture that cares makes its fake of the outside world fail between them (`life`).
 * A test that needs a real SIGKILL keeps its own (`outbound-durable`'s `crash.test.ts`).
 *
 * After a death, the new process gets the same records, the world repeats the scenario (it retries
 * what went unacknowledged, as platforms and users do), and the invariant must hold.
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
  /**
   * After a storage failure the process survived, how long the world waits on the suite's clock
   * before it repeats the scenario: at least the component's own retry delay, if it retries on a
   * timer. Default 0: the world retries at once, and a component that waits on a timer never gets
   * its turn.
   */
  retryAfterMs?: number;
  dispose?(): Promise<void>;
}

const GROUP = "convergence";
/** How many times the world repeats the scenario after a storage failure the process survived. */
const WORLD_RETRIES = 3;

/** What a dead process's storage answers. */
export class SimulatedCrash extends Error {
  constructor() {
    super("convergence: the process crashed here (simulated)");
    this.name = "SimulatedCrash";
  }
}

/** What a live process's storage answers once, at the failure point: the commit did not happen. */
export class SimulatedStorageFailure extends Error {
  constructor() {
    super("convergence: the storage failed this commit (simulated); nothing was written");
    this.name = "SimulatedStorageFailure";
  }
}

/** Where the suite cuts a process: at which commit, and how. */
type Cut =
  /** `at` commits go through; the process dies when it attempts the next. */
  | { kind: "before"; at: number }
  /** Commit `at` (counted from 1) goes through, and the process dies before its caller sees it. */
  | { kind: "after"; at: number }
  /** Commit attempt `at` (counted from 0) is refused, once; the process lives on. */
  | { kind: "fail"; at: number };

type Factory = () => ConvergenceFixture | Promise<ConvergenceFixture>;

export function createConvergenceConformance(factory: Factory): readonly ConformanceCase[] {
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
        await runOnce(factory, { kind: "before", at: Number.POSITIVE_INFINITY });
      },
    },
    {
      group: GROUP,
      name: "a crash after any commit converges on the next process",
      run: async () => {
        // Dies at the attempt of commit k + 1, after what it did since commit k.
        const commits = await runOnce(factory, undefined);
        for (let k = 0; k <= commits; k++) {
          await explain(`after a crash at commit ${k} of ${commits}`, () => runOnce(factory, { kind: "before", at: k }));
        }
      },
    },
    {
      group: GROUP,
      name: "a crash the instant any commit lands converges on the next process",
      run: async () => {
        // Commit k is durable and nothing after it ran. k = 0 is the first cut's.
        const commits = await runOnce(factory, undefined);
        for (let k = 1; k <= commits; k++) {
          await explain(`after a crash right after commit ${k} of ${commits}`, () => runOnce(factory, { kind: "after", at: k }));
        }
      },
    },
    {
      group: GROUP,
      name: "a storage failure at any commit converges once the world retries, on the same process",
      run: async () => {
        const commits = await runOnce(factory, undefined);
        for (let k = 0; k < commits; k++) {
          await explain(`after a storage failure at commit ${k + 1} of ${commits}`, () => runSurvivingFailure(factory, k));
        }
      },
    },
  ];
}

async function explain(where: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${GROUP}: ${where}: ${message}`, { cause: error });
  }
}

/**
 * One run over fresh records. `cut` undefined: one process, then the invariant. A crash: the first
 * process dies at that cut (or runs to the end when it makes fewer commits), a second process takes
 * over, the world repeats the scenario, then the invariant. Returns the first process's commits.
 */
async function runOnce(factory: Factory, cut: Extract<Cut, { kind: "before" | "after" }> | undefined): Promise<number> {
  const fixture = await factory();
  const clock = createManualClock();
  const apps: App[] = [];
  try {
    const first = crashingStorage(fixture.database, cut);
    const one = await openProcess(fixture, first, clock, apps);
    try {
      await untilDeath(first, async () => {
        await one.app.start();
        await fixture.scenario(one);
      });
    } catch (error) {
      if (!first.dead) throw error;
    }
    if (cut === undefined) {
      if (first.dead) throw new Error(`${GROUP}: the process died with no crash point`);
      await fixture.invariant(one);
      return first.commits;
    }

    // The first process is gone: its storage refuses everything, and it stops with no time to finish.
    first.kill();
    await one.app.stop(withAbortSignal(AbortSignal.abort(new SimulatedCrash()), BACKGROUND_CONTEXT)).catch(() => {});

    const second = crashingStorage(fixture.database, undefined);
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

/**
 * One run over fresh records where commit attempt `failAt` fails once and the process lives on. The
 * world repeats the scenario on the same process, at most `WORLD_RETRIES` times, moving the clock by
 * `retryAfterMs` before each; the invariant must hold by then. Bounded: it cannot wait forever.
 */
async function runSurvivingFailure(factory: Factory, failAt: number): Promise<void> {
  const fixture = await factory();
  const clock = createManualClock();
  const apps: App[] = [];
  try {
    let process = await openProcess(fixture, crashingStorage(fixture.database, { kind: "fail", at: failAt }), clock, apps);
    try {
      await process.app.start();
    } catch {
      // A start that fails is a process that exits: a supervisor starts a new one over the records.
      await process.app.stop().catch(() => {});
      process = await openProcess(fixture, crashingStorage(fixture.database, undefined), clock, apps);
      await process.app.start();
    }
    let failure: unknown;
    for (let attempt = 0; attempt <= WORLD_RETRIES; attempt++) {
      if (attempt > 0) await clock.advance(fixture.retryAfterMs ?? 0);
      try {
        // The scenario may reject: a caller that saw the failure retries on the next attempt.
        await fixture.scenario(process);
        await fixture.invariant(process);
        return;
      } catch (error) {
        failure = error;
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`still wrong after the world retried ${WORLD_RETRIES} times (retryAfterMs ${fixture.retryAfterMs ?? 0}): ${message}`, { cause: failure });
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
 * `database`, one call at a time, cut at `cut` (never when undefined). Once the process is dead,
 * every call rejects with `SimulatedCrash`.
 */
function crashingStorage(database: SqlDatabase, cut: Cut | undefined): CrashingStorage {
  const controller = new AbortController();
  let commits = 0;
  let attempts = 0;
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
      const attempt = attempts++;
      if (cut?.kind === "before" && commits >= cut.at) {
        kill();
        throw new SimulatedCrash();
      }
      if (cut?.kind === "fail" && attempt === cut.at) throw new SimulatedStorageFailure();
      const result = await work();
      commits += 1;
      if (cut?.kind === "after" && commits === cut.at) {
        // Durable, and the caller never learns it: the process is gone before it continues.
        kill();
        throw new SimulatedCrash();
      }
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
