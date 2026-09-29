/**
 * The session stores the runtime fixture and its killed workers share over one directory: Pi's JSONL
 * files, or the SQL store on a SQLite file held to a Durable Object's limits. A worker and the test
 * open the same kind over the same `root`, so what a killed worker left is what the next one reads.
 */

import { join } from "node:path";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT } from "@pikit/core";
import { createSqlSessionStore } from "../sql/index.ts";
import type { SessionStore } from "../types.ts";
import { openSqliteDatabase } from "./sqlite.ts";

/** Where a fixture keeps its sessions. */
export type SessionsKind = "jsonl" | "sql";

export interface SessionsAt {
  store: SessionStore;
  /** Resolves once the store can be used (the SQL tables exist). */
  ready: Promise<void>;
  close(): Promise<void>;
}

export function sessionsAt(root: string, kind: SessionsKind): SessionsAt {
  if (kind === "jsonl") {
    return {
      store: new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root }),
      ready: Promise.resolve(),
      close: async () => {},
    };
  }
  const db = openSqliteDatabase(join(root, "sessions.db"), { durableObjectLimits: true });
  const store = createSqlSessionStore(db.database, { cwd: root });
  return {
    store,
    ready: store.migrate(),
    async close() {
      await store.close(BACKGROUND_CONTEXT);
      await db.close();
    },
  };
}
