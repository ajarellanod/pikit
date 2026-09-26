/**
 * storage-sqlite's tests. They are copied with the component and keep running in your project.
 * Every database is a temporary file.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, type SqlDatabase, silentLogger } from "@pikit/core";
import { createLifecycleConformance, createSqlDatabaseConformance } from "@pikit/core/testing";
import storageSqlite from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryPath(name = "pikit.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-storage-sqlite-"));
  directories.push(dir);
  return join(dir, "state", name);
}

const configFor = (path: string) => ({ "storage-sqlite": { path } });

// The storage.sql contract (SPEC §14), including data that outlives the app.
for (const c of createSqlDatabaseConformance(() => ({ components: [storageSqlite], config: configFor(temporaryPath()) }))) {
  test(`storage-sqlite ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline, and a fresh app over the same file starts again.
const lifecyclePath = temporaryPath();
for (const c of createLifecycleConformance(() => ({ component: storageSqlite, config: configFor(lifecyclePath) }))) {
  test(`storage-sqlite ${c.group}: ${c.name}`, () => c.run());
}

async function startFailure(path: string): Promise<Error> {
  const app = await defineApp({ components: [storageSqlite], config: configFor(path), logger: silentLogger }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  // The app wraps a component's start failure; the component's own error is its cause.
  if (!(error.cause instanceof Error)) throw new Error(`expected a cause: ${error.message}`);
  return error.cause;
}

test("a file that is not a database fails the start, naming the file", async () => {
  const path = temporaryPath("not-a-database.db");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "this is not SQLite, it is text long enough to have a header ".repeat(20));
  const error = await startFailure(path);
  expect(error.message).toContain(`storage-sqlite: cannot use ${path} as a database`);
});

test("a directory it cannot create fails the start", async () => {
  // A file stands where the database's directory must go.
  const blocker = temporaryPath("blocker");
  mkdirSync(join(blocker, ".."), { recursive: true });
  writeFileSync(blocker, "a file where a directory must go");
  const error = await startFailure(join(blocker, "pikit.db"));
  expect(error.message).toMatch(/ENOTDIR|EEXIST|not a directory/i);
});

test("the database is in WAL mode, and used after stop it says so", async () => {
  const path = temporaryPath();
  let db: SqlDatabase | undefined;
  const user = defineComponent({
    name: "storage-user",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (db = handle.get()) };
    },
  });
  const app = await defineApp({ components: [storageSqlite, user], config: configFor(path), logger: silentLogger }).create();
  await app.start();
  expect(await db?.query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
  await db?.run("CREATE TABLE t (v INTEGER)");
  expect(existsSync(`${path}-wal`)).toBe(true);
  await app.stop();
  await expect(db?.query("SELECT 1") ?? Promise.resolve()).rejects.toThrow("storage-sqlite: storage.sql used while the app is not running");
});
