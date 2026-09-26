/**
 * The convergence suite against the two ways a component can react to another's facts (SPEC §4.8):
 * reading the producer's feed with a cursor of its own passes; listening to its events alone fails,
 * because a crash between the producer's commit and the listener's loses the reaction for good.
 */

import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { type AppContext, defineComponent } from "../app.ts";
import type { Feed } from "../contracts/feed.ts";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "../contracts/storage.ts";
import { type ConvergenceFixture, createConvergenceConformance } from "./convergence.ts";

declare module "../capabilities.ts" {
  interface AppCapabilities {
    "test.ledger": Ledger;
  }
}
declare module "../events.ts" {
  interface AppEvents {
    "test.convergence.recorded": { id: string };
  }
}

interface Ledger {
  /** Records `id` once; a second time changes nothing. */
  record(id: string, ctx: AppContext): Promise<void>;
  facts: Feed<{ id: string }>;
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
    const converge = async () => {
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
    };
    pikit.on("test.convergence.recorded", () => converge());
    return {
      async start() {
        await sql.get().run("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)");
        await sql.get().run("CREATE TABLE IF NOT EXISTS seen_cursor (cursor TEXT NOT NULL)");
        await converge();
      },
    };
  },
});

const IDS = ["a", "b", "c"];

function fixture(consumer: typeof feedConsumer): ConvergenceFixture {
  const database = memoryDatabase();
  let current: Ledger | undefined;
  return {
    database,
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

for (const c of createConvergenceConformance(() => fixture(feedConsumer))) {
  test(`a consumer reading the feed passes: ${c.name}`, () => c.run());
}

test("a consumer reacting to events alone fails: the crash between the two commits loses a fact", async () => {
  const cases = createConvergenceConformance(() => fixture(eventConsumer));
  // With no crash, events are enough; the suite tells them apart only by crashing.
  await (cases[0] as (typeof cases)[number]).run();
  const crashing = cases.find((c) => c.name.startsWith("a crash after any commit"));
  await expect(crashing?.run()).rejects.toThrow(/after a crash at commit \d+ of \d+: seen/);
});
