/**
 * The SQL session store against Pi's own session suites (SPEC §4: the Durable Object session backend
 * passes Pi's session conformance), on a real SQLite file whose every statement is held to a Durable
 * Object's limits, plus what only a SQL store has to get right: payloads larger than a row, key
 * prefixes as ranges, the schema's migration, and a session read by another process.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, insertEntry, list, setValue, value } from "@earendil-works/pi-agent-core";
import {
  createSessionRepoConformance,
  createSessionRepoStreamingForkConformance,
  createStorageConformance,
  openSqliteDatabase,
  type SqliteDatabase,
  storageOf,
} from "../testing/index.ts";
import { createSqlSessionStore, SCHEMA_VERSION, type SqlSessionStore } from "./index.ts";
import { CHUNK_CHARS, prefixEnd } from "./schema.ts";

const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-sql-sessions-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

/** A migrated store over a new database held to a Durable Object's limits. */
async function newStore(path = databasePath()): Promise<{ store: SqlSessionStore; db: SqliteDatabase }> {
  const db = openSqliteDatabase(path, { durableObjectLimits: true });
  const store = createSqlSessionStore(db.database);
  await store.migrate();
  return { store, db };
}

let current: { store: SqlSessionStore; db: SqliteDatabase } | undefined;
const repo = async () => {
  current = await newStore();
  return current.store;
};
const closeRepo = async () => {
  await current?.store.close(ctx);
  await current?.db.close();
};
for (const c of [...createSessionRepoConformance(repo, closeRepo), ...createSessionRepoStreamingForkConformance(repo, closeRepo)]) {
  test(`sql sessions ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createStorageConformance(async () => {
  const { store, db } = await newStore();
  const session = await store.create({}, ctx);
  return {
    storage: storageOf(session),
    [Symbol.asyncDispose]: async () => {
      await session.close(ctx);
      await store.close(ctx);
      await db.close();
    },
  };
})) {
  test(`sql storage ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

test("an entry, a value and a list element larger than a row are stored in parts and read back whole, in a fork too", async () => {
  const { store, db } = await newStore();
  const session = await store.create({ id: "large" }, ctx);
  // Five times a Durable Object row, with characters of every UTF-8 width and pairs across part edges.
  const text = "a\u00e9\u20ac\u{1f600}".repeat((5 * 1024 * 1024) / 10);
  const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
  const big = value<string>("test.big");
  const bigList = list<string>("test.big");
  await session.mutate(
    (mutator) =>
      mutator.commit(
        [
          insertEntry({ id: "root", parentId: null, type: "message", message }),
          setValue(big, text),
          { kind: "list", op: "append", namespace: bigList.namespace, key: bigList.key, value: text },
        ],
        ctx,
      ),
    ctx,
  );
  const entry = await session.getEntry("root", ctx);
  expect(entry?.type === "message" && entry.message).toEqual(message);
  expect((await session.getValue(big, ctx))?.value).toBe(text);
  expect((await session.readList(bigList, undefined, ctx)).map((element) => element.value)).toEqual([text]);

  const fork = await store.fork(session.metadata, { scope: "tree", id: "large-fork" }, ctx);
  expect((await fork.getValue(big, ctx))?.value).toBe(text);
  expect((await fork.findEntries(undefined, ctx)).length).toBe(1);

  // Replacing a large value leaves none of its parts behind.
  await session.setValue(big, "small", ctx);
  await session.deleteList(bigList, ctx);
  const [parts] = await db.database.query<{ chunks: number; entry: number }>(
    "SELECT (SELECT COUNT(*) FROM sessions_sql_chunks WHERE session_id = 'large') AS chunks, (SELECT parts FROM sessions_sql_entries WHERE session_id = 'large') AS entry",
  );
  expect(parts?.entry).toBeGreaterThan((5 * 1024 * 1024) / 3 / CHUNK_CHARS);
  expect(parts?.chunks).toBe(parts?.entry as number);

  await Promise.all([session.close(ctx), fork.close(ctx)]);
  await store.delete(fork.metadata, ctx);
  const [left] = await db.database.query<{ count: number }>("SELECT COUNT(*) AS count FROM sessions_sql_chunks WHERE session_id = 'large-fork'");
  expect(left?.count).toBe(0);
  await store.close(ctx);
  await db.close();
});

test("the test database refuses what a Durable Object refuses, so the suites above prove the store fits one", async () => {
  const { database, close } = openSqliteDatabase(databasePath(), { durableObjectLimits: true });
  await expect(database.query("SELECT ?", ["x".repeat(2 * 1024 * 1024 + 1)])).rejects.toThrow("a row holds at most 2 MB");
  await expect(database.query(`SELECT ${Array(101).fill("?").join(", ")}`, Array(101).fill(1))).rejects.toThrow("101 bound parameters");
  await expect(database.query(`SELECT 1 WHERE 'a' LIKE ?`, ["a%"])).rejects.toThrow("use a range");
  await expect(database.query(`SELECT '${"x".repeat(100 * 1024)}'`)).rejects.toThrow("over 100 KB");
  await close();
});

test("a key prefix is a range that selects exactly the keys starting with it", () => {
  const keys = ["", "a", "ab", "ab\u{10ffff}", "ab\u{10ffff}z", "ac", "b", "\ud7ff", "\ud7ffx", "\ue000", "\u{10000}"];
  const inRange = (prefix: string, key: string) => {
    const end = prefixEnd(prefix);
    const points = (s: string) => Array.from(s, (c) => c.codePointAt(0) as number);
    const compare = (l: string, r: string) => {
      const [a, b] = [points(l), points(r)];
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
      return a.length - b.length;
    };
    return compare(key, prefix) >= 0 && (end === undefined || compare(key, end) < 0);
  };
  for (const prefix of keys) {
    for (const key of keys) expect(`${prefix} ${key} ${inRange(prefix, key)}`).toBe(`${prefix} ${key} ${key.startsWith(prefix)}`);
  }
});

test("a session written by one process is read by another over the same database, and find looks it up by id", async () => {
  const path = databasePath();
  const first = await newStore(path);
  const second = await newStore(path);
  const session = await first.store.create({ id: "shared", cwd: "/work" }, ctx);
  await session.setName("shared name", ctx);
  await session.close(ctx);

  const metadata = await second.store.find("shared", ctx);
  expect(metadata).toEqual({ id: "shared", createdAt: session.metadata.createdAt, storageVersion: 1, cwd: "/work" });
  expect(await second.store.find("missing", ctx)).toBeUndefined();
  const reopened = await second.store.open(metadata ?? session.metadata, ctx);
  expect(await reopened.getName(ctx)).toBe("shared name");
  await reopened.close(ctx);
  for (const { store, db } of [first, second]) {
    await store.close(ctx);
    await db.close();
  }
});

test("migrate is idempotent, and refuses a database from a newer schema", async () => {
  const path = databasePath();
  const { store, db } = await newStore(path);
  await store.migrate();
  await db.database.run("UPDATE sessions_sql_meta SET value = ? WHERE name = 'schema_version'", [SCHEMA_VERSION + 1]);
  await expect(store.migrate()).rejects.toThrow("newer than this version's");
  await db.close();
});

test("a closed store refuses new calls and closes the sessions still open", async () => {
  const { store, db } = await newStore();
  const session = await store.create({}, ctx);
  await store.close(ctx);
  await expect(session.getName(ctx)).rejects.toThrow("closed");
  await expect(store.list(undefined, ctx)).rejects.toThrow("closed");
  await db.close();
});
