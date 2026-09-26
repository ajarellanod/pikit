/**
 * `storage.sql` conformance (SPEC §4.5, §14): what every `SqlDatabase` must do, wherever its data
 * lives. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createSqlDatabaseConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite reaches the database through the capability, as a component would. It uses only SQL
 * that SQLite and Postgres both accept.
 */

import { type App, type ComponentDefinition, defineApp, defineComponent } from "../app.ts";
import { silentLogger } from "../contracts/logger.ts";
import type { SqlDatabase, SqlRow } from "../contracts/storage.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** A fresh, empty database, built for one case. */
export interface SqlDatabaseFixture {
  /**
   * The component providing `storage.sql`, and anything it uses. The suite may create several apps
   * from them over the same data, one after the other, so the data lives outside the components'
   * setup (in the fixture: a file, a schema).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Release what the fixture holds (temporary files). */
  dispose?(): Promise<void>;
}

const GROUP = "storage.sql";
const expect = expecter(GROUP);
const check = checker(GROUP);

export function createSqlDatabaseConformance(factory: () => SqlDatabaseFixture | Promise<SqlDatabaseFixture>): readonly ConformanceCase[] {
  const sqlCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const apps: App[] = [];
      try {
        await run(createSubject(fixture, apps));
      } finally {
        for (const app of apps) await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    sqlCase("values read back as they were written: text, integers, reals, null and bytes", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_values (id INTEGER PRIMARY KEY, t TEXT, i INTEGER, r REAL, n TEXT, b BLOB)");
      const text = "ñandú ✓ \"quoted\" 'single' \\ \n tab\t";
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await db.run("INSERT INTO conformance_values (id, t, i, r, n, b) VALUES (?, ?, ?, ?, ?, ?)", [1, text, 9_007_199_254_740_991, 1.5, null, bytes]);
      const [row] = await db.query("SELECT t, i, r, n, b FROM conformance_values WHERE id = ?", [1]);
      check(row !== undefined, "the inserted row to read back");
      expect(row?.t, text, "text");
      expect(row?.i, 9_007_199_254_740_991, "an integer (as a number)");
      expect(row?.r, 1.5, "a real");
      expect(row?.n, null, "null");
      check(row?.b instanceof Uint8Array, "bytes to read back as a Uint8Array");
      expect([...((row?.b as Uint8Array | undefined) ?? [])], [...bytes], "bytes");
    }),

    sqlCase("parameters are bound, never interpolated", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_bound (v TEXT)");
      const hostile = "'); DROP TABLE conformance_bound; --";
      await db.run("INSERT INTO conformance_bound (v) VALUES (?)", [hostile]);
      expect(await db.query("SELECT v FROM conformance_bound"), [{ v: hostile }], "the value, stored as it is");
    }),

    sqlCase("run says how many rows a statement changed; query returns rows in the order asked", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_changes (k TEXT PRIMARY KEY, v INTEGER)");
      for (const [k, v] of [["b", 2], ["a", 1], ["c", 3]] as const) await db.run("INSERT INTO conformance_changes (k, v) VALUES (?, ?)", [k, v]);
      expect(await db.run("UPDATE conformance_changes SET v = v + 10 WHERE v >= ?", [2]), { changes: 2 }, "changes of an UPDATE");
      expect(await db.run("DELETE FROM conformance_changes WHERE k = ?", ["nope"]), { changes: 0 }, "changes of a DELETE that matched nothing");
      expect(await db.query("SELECT k, v FROM conformance_changes ORDER BY k"), [{ k: "a", v: 1 }, { k: "b", v: 12 }, { k: "c", v: 13 }], "rows in ORDER BY order");
      expect(await db.query("SELECT k FROM conformance_changes WHERE k = ?", ["none"]), [], "no rows");
    }),

    sqlCase("a transaction commits all its statements and returns what its work returns", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_tx (v INTEGER)");
      const result = await db.transaction(async (tx) => {
        await tx.run("INSERT INTO conformance_tx (v) VALUES (?)", [1]);
        await tx.run("INSERT INTO conformance_tx (v) VALUES (?)", [2]);
        const inside = await tx.query<{ n: number } & SqlRow>("SELECT COUNT(*) AS n FROM conformance_tx");
        return inside[0]?.n;
      });
      expect(result, 2, "the work's result, which saw its own writes");
      expect(await db.query("SELECT v FROM conformance_tx ORDER BY v"), [{ v: 1 }, { v: 2 }], "both rows, committed");
    }),

    sqlCase("a transaction whose work rejects changes nothing and rejects with the same error", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_rollback (v INTEGER)");
      await db.run("INSERT INTO conformance_rollback (v) VALUES (?)", [1]);
      const failure = new Error("conformance: the work failed");
      const caught = await db
        .transaction(async (tx) => {
          await tx.run("INSERT INTO conformance_rollback (v) VALUES (?)", [2]);
          await tx.run("UPDATE conformance_rollback SET v = ?", [99]);
          throw failure;
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      check(caught === failure, "the transaction to reject with the work's own error");
      expect(await db.query("SELECT v FROM conformance_rollback"), [{ v: 1 }], "the table as it was before the transaction");
    }),

    sqlCase("a failing statement rejects, and the database is still usable; inside a transaction it rolls back", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_errors (k TEXT PRIMARY KEY)");
      await db.run("INSERT INTO conformance_errors (k) VALUES (?)", ["a"]);
      const duplicate = await db.run("INSERT INTO conformance_errors (k) VALUES (?)", ["a"]).then(
        () => false,
        () => true,
      );
      check(duplicate, "a primary key violation to reject");
      const syntax = await db.query("SELEKT nonsense").then(
        () => false,
        () => true,
      );
      check(syntax, "a syntax error to reject");
      const inTransaction = await db
        .transaction(async (tx) => {
          await tx.run("INSERT INTO conformance_errors (k) VALUES (?)", ["b"]);
          await tx.run("INSERT INTO conformance_errors (k) VALUES (?)", ["a"]);
        })
        .then(
          () => false,
          () => true,
        );
      check(inTransaction, "a transaction whose statement fails to reject");
      expect(await db.query("SELECT k FROM conformance_errors ORDER BY k"), [{ k: "a" }], "only the row before the failures");
    }),

    sqlCase("concurrent transactions do not lose each other's updates", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_counter (id INTEGER PRIMARY KEY, n INTEGER)");
      await db.run("INSERT INTO conformance_counter (id, n) VALUES (?, ?)", [1, 0]);
      // Read-modify-write inside each transaction: without isolation, increments would be lost.
      const increment = () =>
        db.transaction(async (tx) => {
          const [row] = await tx.query<{ n: number } & SqlRow>("SELECT n FROM conformance_counter WHERE id = ?", [1]);
          await tx.run("UPDATE conformance_counter SET n = ? WHERE id = ?", [(row?.n ?? 0) + 1, 1]);
        });
      await Promise.all(Array.from({ length: 50 }, increment));
      expect(await db.query("SELECT n FROM conformance_counter"), [{ n: 50 }], "every increment");
    }),

    sqlCase("a statement outside a transaction never sees half of it", async (s) => {
      const db = await s.open();
      await db.run("CREATE TABLE conformance_halves (v INTEGER)");
      const seen = new Set<number>();
      let writing = true;
      const reader = (async () => {
        while (writing) {
          const [row] = await db.query<{ n: number } & SqlRow>("SELECT COUNT(*) AS n FROM conformance_halves");
          seen.add(row?.n ?? -1);
        }
      })();
      for (let i = 0; i < 20; i++) {
        await db.transaction(async (tx) => {
          await tx.run("INSERT INTO conformance_halves (v) VALUES (?)", [i]);
          for (let j = 0; j < 5; j++) await tx.query("SELECT COUNT(*) AS n FROM conformance_halves");
          await tx.run("INSERT INTO conformance_halves (v) VALUES (?)", [i]);
        });
      }
      writing = false;
      await reader;
      check(
        [...seen].every((n) => n % 2 === 0),
        `only whole transactions to be visible outside them (counts seen: ${[...seen].sort((a, b) => a - b).join(", ")})`,
      );
    }),

    sqlCase("data survives a new app over the same storage", async (s) => {
      const first = await s.open();
      await first.run("CREATE TABLE conformance_durable (k TEXT PRIMARY KEY, v TEXT)");
      await first.run("INSERT INTO conformance_durable (k, v) VALUES (?, ?)", ["kept", "yes"]);
      await s.stopAll();
      const second = await s.open();
      expect(await second.query("SELECT k, v FROM conformance_durable"), [{ k: "kept", v: "yes" }], "the row, after a restart");
    }),
  ];
}

interface Subject {
  /** Starts a new app over the fixture's storage and returns its `storage.sql`. */
  open(): Promise<SqlDatabase>;
  /** Stops every app started so far, as a process that exits. */
  stopAll(): Promise<void>;
}

function createSubject(fixture: SqlDatabaseFixture, apps: App[]): Subject {
  return {
    async open() {
      let database: SqlDatabase | undefined;
      const consumer = defineComponent({
        name: "storage-sql-conformance",
        setup(pikit) {
          const handle = pikit.use("storage.sql");
          return {
            start() {
              database = handle.get();
            },
          };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      apps.push(app);
      await app.start();
      if (database === undefined) throw new Error(`${GROUP}: storage.sql was not resolved`);
      return database;
    },
    async stopAll() {
      for (const app of apps.splice(0)) await app.stop();
    },
  };
}
