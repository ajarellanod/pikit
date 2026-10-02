/**
 * pi-durable's `SqliteStorage` over `storage.sql` (spike, README.md): pi-durable's own storage
 * conformance suite on storage-sqlite's `storage.sql`, and on a database held to a Durable Object's
 * SQL limits; then a `Harness` over it, reopened as a new app over the same file.
 */

import { afterAll, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import type { SqlDatabase } from "@pikit/contracts";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import storageSqlite from "../../../../registry/components/storage-sqlite/files/src/pikit/storage-sqlite/index.ts";
import { openSqliteDatabase } from "../testing/sqlite.ts";
import { openDurableStorage, splitSqlStatements, sqliteDatabaseFrom } from "./sql.ts";
import { answerOnce, answerWithTool, checkReopened, interruptGeneration, pendingWork, resumeInterrupted } from "./testing.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-durable-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

/** A started app with storage-sqlite over `path`, and its `storage.sql`. */
async function openApp(path: string): Promise<{ db: SqlDatabase; stop(): Promise<void> }> {
  let db: SqlDatabase | undefined;
  const reader = defineComponent({
    name: "durable-reader",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (db = handle.get()) };
    },
  });
  const app = await defineApp({ components: [storageSqlite, reader], config: { "storage-sqlite": { path } }, logger: silentLogger }).create();
  await app.start();
  if (db === undefined) throw new Error("storage.sql was not resolved");
  return { db, stop: () => app.stop() };
}

// bun:test's `expect` has every matcher the suite's adapter calls; no shim is needed.
registerStorageConformance({ describe, expect, it }, "pi-durable storage over storage-sqlite", async (use) => {
  const { db, stop } = await openApp(databasePath());
  try {
    const storage = await openDurableStorage(db);
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
    }
  } finally {
    await stop();
  }
});

// The same suite with every statement held to what a Durable Object's SQL accepts.
registerStorageConformance({ describe, expect, it }, "pi-durable storage within Durable Object limits", async (use) => {
  const sqlite = openSqliteDatabase(databasePath(), { durableObjectLimits: true });
  try {
    const storage = await openDurableStorage(sqlite.database);
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
    }
  } finally {
    await sqlite.close();
  }
});

describe("the facade", () => {
  test("a transaction handle refuses statements once its callback settled; a rejection rolls back with the same error", async () => {
    const { db, stop } = await openApp(databasePath());
    try {
      const facade = sqliteDatabaseFrom(db);
      await facade.exec("CREATE TABLE durable_t (v TEXT)");
      let leaked: Parameters<Parameters<typeof facade.transaction>[0]>[0] | undefined;
      await facade.transaction(async (tx) => {
        leaked = tx;
        await tx.run("INSERT INTO durable_t (v) VALUES (?)", "kept");
      });
      await expect(leaked!.run("INSERT INTO durable_t (v) VALUES (?)", "late")).rejects.toThrow("no longer active");
      const failure = new Error("callback failed");
      await expect(
        facade.transaction(async (tx) => {
          await tx.run("INSERT INTO durable_t (v) VALUES (?)", "rolled back");
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await facade.all("SELECT v FROM durable_t")).toEqual([{ v: "kept" }]);
    } finally {
      await stop();
    }
  });

  test("statements wait for a running transaction; close waits for them and refuses new ones", async () => {
    const { db, stop } = await openApp(databasePath());
    try {
      const facade = sqliteDatabaseFrom(db);
      await facade.exec("CREATE TABLE durable_q (v INTEGER)");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const order: string[] = [];
      const tx = facade.transaction(async (t) => {
        await t.run("INSERT INTO durable_q (v) VALUES (1)");
        await held;
        await t.run("INSERT INTO durable_q (v) VALUES (2)");
        order.push("tx");
      });
      const read = facade.all<{ v: number }>("SELECT v FROM durable_q ORDER BY v").then((rows) => {
        order.push("read");
        return rows;
      });
      await Bun.sleep(5);
      expect(order).toEqual([]);
      release();
      expect(await read).toEqual([{ v: 1 }, { v: 2 }]);
      await tx;
      expect(order).toEqual(["tx", "read"]);
      await facade.close();
      await expect(facade.get("SELECT 1")).rejects.toThrow("closed");
      // The database is the app's: still open.
      expect(await db.query("SELECT count(*) AS n FROM durable_q")).toEqual([{ n: 2 }]);
    } finally {
      await stop();
    }
  });

  test("bigints bind as numbers up to 2^53; past it they throw", async () => {
    const { db, stop } = await openApp(databasePath());
    try {
      const facade = sqliteDatabaseFrom(db);
      expect(await facade.get("SELECT ? AS v", 9_007_199_254_740_991n)).toEqual({ v: 9_007_199_254_740_991 });
      await expect(facade.get("SELECT ? AS v", 9_007_199_254_740_992n)).rejects.toThrow("2^53");
    } finally {
      await stop();
    }
  });

  test("exec runs several statements as one step; separators in strings, comments and trigger bodies stay", async () => {
    const { db, stop } = await openApp(databasePath());
    try {
      const facade = sqliteDatabaseFrom(db);
      await facade.exec(`
        CREATE TABLE durable_log (v TEXT); -- a comment; with a semicolon
        CREATE TABLE durable_src (v TEXT);
        /* a block; comment */
        CREATE TEMP TRIGGER durable_copy AFTER INSERT ON durable_src BEGIN
          INSERT INTO durable_log (v) VALUES (CASE WHEN new.v = 'a;b' THEN 'semi;colon' ELSE new.v END);
          INSERT INTO durable_log (v) VALUES ('second;');
        END;
        INSERT INTO durable_src (v) VALUES ('a;b');
      `);
      expect(await facade.all("SELECT v FROM durable_log ORDER BY rowid")).toEqual([{ v: "semi;colon" }, { v: "second;" }]);
      // A failing statement undoes the ones before it in the same exec.
      await expect(facade.exec("INSERT INTO durable_log (v) VALUES ('x'); INSERT INTO missing VALUES (1)")).rejects.toThrow();
      expect(await facade.all("SELECT v FROM durable_log WHERE v = 'x'")).toEqual([]);
    } finally {
      await stop();
    }
  });

  test("splitSqlStatements", () => {
    expect(splitSqlStatements("SELECT 1; ; -- only a comment\n")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements(`SELECT 'it''s; fine', "a;b", [c;d], \`e;f\`; SELECT 2`)).toEqual([`SELECT 'it''s; fine', "a;b", [c;d], \`e;f\``, "SELECT 2"]);
    expect(splitSqlStatements("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT CASE WHEN 1 THEN 2 END; END; SELECT 3")).toEqual([
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT CASE WHEN 1 THEN 2 END; END",
      "SELECT 3",
    ]);
    expect(splitSqlStatements("SELECT CASE WHEN 1 THEN 2 END; SELECT 3")).toEqual(["SELECT CASE WHEN 1 THEN 2 END", "SELECT 3"]);
  });
});

describe("a Harness over storage-sqlite's storage.sql", () => {
  test("answers, finds a resubmitted requestId, and a new app over the same file finds root and transcript", async () => {
    const path = databasePath();
    const first = await openApp(path);
    const run = await answerOnce(first.db).finally(() => first.stop());
    const second = await openApp(path);
    await checkReopened(second.db, run).finally(() => second.stop());
  });

  test("a tool call is validated, run and answered", async () => {
    const { db, stop } = await openApp(databasePath());
    await answerWithTool(db).finally(stop);
  });

  test("a run interrupted mid-generation resumes in a new app over the same file", async () => {
    const path = databasePath();
    const first = await openApp(path);
    const run = await interruptGeneration(first.db).finally(() => first.stop());
    const inspecting = await openApp(path);
    const pending = await pendingWork(inspecting.db).finally(() => inspecting.stop());
    expect(pending.tasks.map((t) => t.kind)).toContain("pi.generation");
    expect(pending.submissions).toEqual(["placed"]);
    const second = await openApp(path);
    await resumeInterrupted(second.db, run).finally(() => second.stop());
  });
});
