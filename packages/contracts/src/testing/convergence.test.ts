/**
 * The convergence suite against the ways a component can react to another's facts (SPEC K3):
 * reading the producer's feed with a cursor of its own passes; listening to its events alone fails,
 * because a crash between the producer's commit and the listener's loses the reaction for good.
 *
 * And against a consumer with an effect in the outside world (claim, call, done): one that redoes a
 * claimed task on recovery passes; one that takes "claimed" for done passes a death at the next
 * commit (its call had already run) and fails a death the instant the claim lands.
 */

import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { type AppContext, type Clock, defineComponent } from "@pikit/core";
import type { Feed } from "../feed.ts";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "../storage.ts";
import { type ConvergenceFixture, createConvergenceConformance, type ProcessLife } from "./convergence.ts";

declare module "@pikit/core" {
  interface AppCapabilities {
    "test.ledger": Ledger;
    "test.api": Api;
  }
}
declare module "@pikit/core" {
  interface AppEvents {
    "test.convergence.recorded": { id: string };
  }
}

interface Ledger {
  /** Records `id` once; a second time changes nothing. */
  record(id: string, ctx: AppContext): Promise<void>;
  facts: Feed<{ id: string }>;
}

/** The outside world a consumer acts on: a call it cannot take back. */
interface Api {
  call(id: string): Promise<void>;
}

/** How long a consumer waits, on the app's clock, before it retries a pass that failed. */
const RETRY_MS = 1_000;

/**
 * Runs `pass` one at a time; a pass that fails is retried after `RETRY_MS` while the process runs.
 * A failed listener only delays a consumer if something ends the delay: this timer.
 */
function passes(pass: () => Promise<void>) {
  let clock: Clock | undefined;
  let running = false;
  let line: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    const next = line.then(pass);
    line = next.catch(() => {
      // The retried pass schedules its own retry if it fails too.
      if (running && clock !== undefined) void clock.sleep(RETRY_MS).then(() => (running ? run() : undefined)).catch(() => {});
    });
    return next;
  };
  return {
    run,
    start(ctx: AppContext) {
      clock = ctx.clock;
      running = true;
    },
    stop() {
      running = false;
    },
  };
}

function memoryDatabase(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  const statements: SqlStatements = {
    query: async <Row extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) => db.prepare(sql).all(...params) as Row[],
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
  };
  return {
    ...statements,
    async transaction(work) {
      db.exec("BEGIN");
      try {
        const result = await work(statements);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** The producer: records each fact in its table and tells listeners about new ones. */
const ledger = defineComponent({
  name: "ledger",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    pikit.provide("test.ledger", {
      async record(id, ctx) {
        const inserted = await sql.get().run("INSERT INTO ledger_facts (id) VALUES (?) ON CONFLICT (id) DO NOTHING", [id]);
        if (inserted.changes === 1) await ctx.emit("test.convergence.recorded", { id });
      },
      facts: {
        async read(after, limit) {
          const rows = await sql.get().query<{ seq: number; id: string }>("SELECT seq, id FROM ledger_facts WHERE seq > ? ORDER BY seq LIMIT ?", [Number(after ?? 0), limit]);
          return { items: rows.map((row) => ({ cursor: String(row.seq), fact: { id: row.id } })), gap: false };
        },
      },
    });
    return {
      async start() {
        await sql.get().run("CREATE TABLE IF NOT EXISTS ledger_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE)");
      },
    };
  },
});

/** A consumer that trusts the event: correct until a process dies between the two commits. */
const eventConsumer = defineComponent({
  name: "event-consumer",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    pikit.use("test.ledger");
    pikit.on("test.convergence.recorded", async ({ id }) => {
      await sql.get().run("INSERT INTO seen (id) VALUES (?) ON CONFLICT (id) DO NOTHING", [id]);
    });
    return {
      async start() {
        await sql.get().run("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)");
      },
    };
  },
});

/** A consumer that reads the feed from its own cursor: the event only wakes it sooner. */
const feedConsumer = defineComponent({
  name: "feed-consumer",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const source = pikit.use("test.ledger");
    const converge = passes(async () => {
      const db = sql.get();
      for (;;) {
        const [row] = await db.query<{ cursor: string }>("SELECT cursor FROM seen_cursor");
        const page = await source.get().facts.read(row?.cursor, 10);
        const last = page.items.at(-1);
        if (last === undefined) return;
        await db.transaction(async (tx) => {
          for (const { fact } of page.items) await tx.run("INSERT INTO seen (id) VALUES (?) ON CONFLICT (id) DO NOTHING", [fact.id]);
          await tx.run("DELETE FROM seen_cursor");
          await tx.run("INSERT INTO seen_cursor (cursor) VALUES (?)", [last.cursor]);
        });
      }
    });
    pikit.on("test.convergence.recorded", () => converge.run());
    return {
      async start(ctx) {
        await sql.get().run("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)");
        await sql.get().run("CREATE TABLE IF NOT EXISTS seen_cursor (cursor TEXT NOT NULL)");
        converge.start(ctx);
        await converge.run();
      },
      stop: () => converge.stop(),
    };
  },
});

/**
 * A consumer with an effect: for each fact it claims a task (with its cursor, in one commit), calls
 * the API, then marks the task done. The call is at-least-once: a claimed task whose outcome was
 * lost is called again. `recovery` says what a new process does with the tasks left claimed.
 */
function effectConsumer(recovery: "call again" | "assume done") {
  return defineComponent({
    name: "effect-consumer",
    setup(pikit) {
      const sql = pikit.use("storage.sql");
      const source = pikit.use("test.ledger");
      const api = pikit.use("test.api");
      const act = async (id: string) => {
        await api.get().call(id);
        await sql.get().run("UPDATE tasks SET state = 'done' WHERE id = ?", [id]);
      };
      const converge = passes(async () => {
        const db = sql.get();
        if (recovery === "call again") {
          for (const { id } of await db.query<{ id: string }>("SELECT id FROM tasks WHERE state = 'claimed' ORDER BY id")) await act(id);
        }
        for (;;) {
          const [row] = await db.query<{ cursor: string }>("SELECT cursor FROM tasks_cursor");
          const [item] = (await source.get().facts.read(row?.cursor, 1)).items;
          if (item === undefined) return;
          await db.transaction(async (tx) => {
            await tx.run("INSERT INTO tasks (id, state) VALUES (?, 'claimed') ON CONFLICT (id) DO NOTHING", [item.fact.id]);
            await tx.run("DELETE FROM tasks_cursor");
            await tx.run("INSERT INTO tasks_cursor (cursor) VALUES (?)", [item.cursor]);
          });
          await act(item.fact.id);
        }
      });
      pikit.on("test.convergence.recorded", () => converge.run());
      return {
        async start(ctx) {
          const db = sql.get();
          await db.run("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
          await db.run("CREATE TABLE IF NOT EXISTS tasks_cursor (cursor TEXT NOT NULL)");
          // The bug: a claimed task's call may never have been made.
          if (recovery === "assume done") await db.run("UPDATE tasks SET state = 'done' WHERE state = 'claimed'");
          converge.start(ctx);
          await converge.run();
        },
        stop: () => converge.stop(),
      };
    },
  });
}

const IDS = ["a", "b", "c"];

/** The API's fake: what it received, across every process. A dead process reaches no API. */
function fakeApi(calls: string[], life: ProcessLife) {
  return defineComponent({
    name: "api",
    setup: (pikit) =>
      pikit.provide("test.api", {
        async call(id) {
          if (life.dead) throw new Error("the process is dead");
          calls.push(id);
        },
      }),
  });
}

function fixture(consumer: typeof feedConsumer): ConvergenceFixture {
  const database = memoryDatabase();
  let current: Ledger | undefined;
  return {
    database,
    retryAfterMs: RETRY_MS,
    components: () => [
      ledger,
      consumer,
      defineComponent({
        name: "world",
        setup(pikit) {
          const handle = pikit.use("test.ledger");
          return { start: () => void (current = handle.get()) };
        },
      }),
    ],
    async scenario({ app }) {
      const ctx = app.context();
      for (const id of IDS) await current?.record(id, ctx);
    },
    async invariant() {
      const seen = (await database.query<{ id: string }>("SELECT id FROM seen ORDER BY id")).map((r) => r.id);
      if (seen.join(",") !== IDS.join(",")) throw new Error(`seen ${JSON.stringify(seen)}, expected ${JSON.stringify(IDS)}`);
    },
  };
}

/** The ledger world with a consumer that calls the API; the invariant is that every fact was acted on. */
function effectFixture(recovery: "call again" | "assume done"): ConvergenceFixture {
  const database = memoryDatabase();
  const calls: string[] = [];
  let current: Ledger | undefined;
  return {
    database,
    retryAfterMs: RETRY_MS,
    components: (life) => [
      ledger,
      fakeApi(calls, life),
      effectConsumer(recovery),
      defineComponent({
        name: "world",
        setup(pikit) {
          const handle = pikit.use("test.ledger");
          return { start: () => void (current = handle.get()) };
        },
      }),
    ],
    async scenario({ app }) {
      const ctx = app.context();
      for (const id of IDS) await current?.record(id, ctx);
    },
    async invariant() {
      const missing = IDS.filter((id) => !calls.includes(id));
      if (missing.length > 0) throw new Error(`the API never got ${JSON.stringify(missing)}; it got ${JSON.stringify(calls)}`);
    },
  };
}

const named = (cases: ReturnType<typeof createConvergenceConformance>, start: string) => {
  const found = cases.find((c) => c.name.startsWith(start));
  if (found === undefined) throw new Error(`no case starts with "${start}"`);
  return found;
};

for (const c of createConvergenceConformance(() => fixture(feedConsumer))) {
  test(`a consumer reading the feed passes: ${c.name}`, () => c.run());
}

test("a consumer reacting to events alone fails: the crash between the two commits loses a fact", async () => {
  const cases = createConvergenceConformance(() => fixture(eventConsumer));
  // With no crash, events are enough; the suite tells them apart only by crashing.
  await (cases[0] as (typeof cases)[number]).run();
  await expect(named(cases, "a crash after any commit").run()).rejects.toThrow(/after a crash at commit \d+ of \d+: seen/);
  // A failed listener is the same loss with the process alive: no event comes again.
  await expect(named(cases, "a storage failure").run()).rejects.toThrow(/after a storage failure at commit \d+ of \d+: still wrong .*: seen/);
});

for (const c of createConvergenceConformance(() => effectFixture("call again"))) {
  test(`a consumer that calls a claimed task again passes: ${c.name}`, () => c.run());
}

test("a consumer that takes a claimed task for done passes a death at the next commit, and fails one right after the claim", async () => {
  const cases = createConvergenceConformance(() => effectFixture("assume done"));
  // What the suite proved before it cut right after a commit: the buggy consumer passes all of it.
  for (const name of ["with no crash", "the world repeating", "a crash after any commit", "a storage failure"]) await named(cases, name).run();
  await expect(named(cases, "a crash the instant any commit lands").run()).rejects.toThrow(/after a crash right after commit \d+ of \d+: the API never got/);
});
