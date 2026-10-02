/**
 * The `agent.runtime` conformance fixture on Pi, on a server: the records are a SQLite file in a
 * temporary directory (what storage-sqlite provides), so they outlive a worker as a real database does.
 * The fixture itself is `createRuntimeFixture` (`runtime-fixture.ts`, neutral); this file gives it a
 * file. And `sqliteStorage`, a `storage.sql` for tests, on a file or in memory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComponentDefinition, defineComponent } from "@pikit/core";
import type { SqlDatabase } from "@pikit/contracts";
import type { AgentRuntimeFixture } from "@pikit/contracts/testing";
import { createRuntimeFixture, testComponents as neutralComponents, type TestComponents } from "./runtime-fixture.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export function createPiRuntimeFixture(runtime: ComponentDefinition[]): AgentRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "pikit-pi-"));
  const path = join(root, "pikit.db");
  return createRuntimeFixture(runtime, {
    components: [sqliteStorage(path)],
    open: async () => openSqliteDatabase(path),
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  });
}

/**
 * `storage.sql` for tests, as storage-sqlite provides it: over the SQLite file at `path`, opened at
 * start and closed at stop, so apps one after the other share what it holds. Without `path`, one
 * database in memory, open from the first start on and never closed: every app the component is in
 * shares it, as a restart over a database would.
 */
export function sqliteStorage(path?: string): ComponentDefinition {
  let memory: SqliteDatabase | undefined;
  return defineComponent({
    name: "storage-test",
    setup(pikit) {
      let open: SqliteDatabase | undefined;
      const current = (): SqlDatabase => {
        if (open === undefined) throw new Error("storage-test: storage.sql used while the app is not running");
        return open.database;
      };
      pikit.provide("storage.sql", {
        query: (sql, params) => current().query(sql, params),
        run: (sql, params) => current().run(sql, params),
        transaction: (work) => current().transaction(work),
      });
      return {
        start() {
          open = path === undefined ? (memory ??= openSqliteDatabase(":memory:")) : openSqliteDatabase(path);
        },
        async stop() {
          const closing = open;
          open = undefined;
          if (path !== undefined) await closing?.close();
        },
      };
    },
  });
}

/** What a runtime uses, for tests on a server: `testComponents` (neutral) and `storage.sql` in memory. */
export interface ServerTestComponents extends TestComponents {
  storage: ComponentDefinition;
}

/**
 * `testComponents` with `storage`: a `storage.sql` in memory (`sqliteStorage()`), which runtime-pi
 * keeps its conversations in.
 */
export function testComponents(options: Parameters<typeof neutralComponents>[0] = {}): ServerTestComponents {
  return { ...neutralComponents(options), storage: sqliteStorage() };
}
