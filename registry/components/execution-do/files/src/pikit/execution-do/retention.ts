/**
 * Retention (`retentionDays`): the object's workspace (every file, directory and symlink of the
 * `execution_do_*` tables: `/work`, `/tmp`, clones) is deleted once nothing has worked in it for that
 * many days. The object is the chat (`idFromName(key)`: a reset keeps its key), so this is a chat's
 * workspace, every agent's in it. The conversation's own records (its transcript, in other tables)
 * are not this component's, and stay.
 *
 * - **Used** means a call of the environment (`track`): a command, a file read or written. It is noted
 *   in memory at once, and at most once an hour in the object's SQL (`execution_do_retention`), with a
 *   request to `wakeups` for the day it expires: the object is woken once, N days after its last
 *   noted use, by its own alarm. An object that already has files when retention is first set (or
 *   when its row is missing) starts its count at its next start.
 * - **Woken**, the handler checks again: a call running (a command, a file operation) asks again in an
 *   hour; a use since asks again for its own expiry; else everything is deleted (`files.clear`) and
 *   `root` made again. The check and the deletion are synchronous (the object's SQL is), so no call
 *   starts between them: a call after it finds an empty workspace, never a half-deleted one.
 * - **Logged** with the bytes deleted, never a file's name.
 *
 * Its limit: an object is code only while an event runs. One that never wakes again after
 * `retentionDays` is set (no message, no alarm) is never looked at: Cloudflare offers no way to list a
 * namespace's objects, so its files stay until it wakes.
 */

import type { AppContext, Clock, Logger } from "@pikit/core";
import type { Wakeups } from "@pikit/contracts";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import type { DurableObjectFilesStorage, Files } from "./files.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The wakeup's name, and the table of the last noted use (one row, while there are files to delete). */
export const WAKEUP = "execution-do:retention";
export const RETENTION_TABLE = "execution_do_retention";

export interface RetentionOptions {
  files: Files;
  storage(): DurableObjectFilesStorage;
  /** Made again once the workspace is deleted. */
  root: string;
  days: number;
  clock: Clock;
  wakeups(): Wakeups;
  log: Pick<Logger, "info" | "warn">;
}

export function createRetention(options: RetentionOptions) {
  const { files, root, days, clock, log } = options;
  /** Calls of the environment running now. */
  let active = 0;
  /** The last use this instance saw, and when it last noted one in SQL. */
  let used = Number.NEGATIVE_INFINITY;
  let noted = Number.NEGATIVE_INFINITY;
  let background: AppContext | undefined;

  const sql = (query: string, ...bindings: (string | number | null)[]) => options.storage().sql.exec(query, ...bindings).toArray();
  const usedAt = (): number | undefined => sql(`SELECT used_at FROM ${RETENTION_TABLE} WHERE id = 0`)[0]?.used_at as number | undefined;

  /** Notes a use now: in memory, and at most once an hour in SQL with the wakeup for its expiry. Never rejects. */
  const note = async (): Promise<void> => {
    const now = clock.now();
    used = now;
    const ctx = background;
    if (ctx === undefined || now - noted < HOUR) return;
    noted = now;
    try {
      sql(`INSERT INTO ${RETENTION_TABLE} (id, used_at) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET used_at = excluded.used_at`, now);
      await options.wakeups().at(WAKEUP, now + days * DAY, ctx);
    } catch (error) {
      // The next use tries again.
      noted = Number.NEGATIVE_INFINITY;
      log.warn("execution-do: retention could not note the workspace's use", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** The wakeup: deletes the workspace when it is due and nothing runs in it; otherwise asks again. */
  const expire = async (ctx: AppContext): Promise<void> => {
    const now = clock.now();
    if (active > 0) return options.wakeups().at(WAKEUP, now + HOUR, ctx);
    const last = Math.max(used, usedAt() ?? Number.NEGATIVE_INFINITY);
    // Nothing noted since the last deletion: nothing to delete.
    if (last === Number.NEGATIVE_INFINITY) return;
    if (now < last + days * DAY) return options.wakeups().at(WAKEUP, last + days * DAY, ctx);
    // Synchronous from the check on: no call starts in between.
    const bytes = files.clear();
    files.mkdirp(root);
    sql(`DELETE FROM ${RETENTION_TABLE}`);
    used = Number.NEGATIVE_INFINITY;
    noted = Number.NEGATIVE_INFINITY;
    log.info(`execution-do: deleted the workspace, unused for ${days} days (retentionDays)`, { bytes });
  };

  return {
    /** Creates its table, registers its wakeup, and starts the count of files from before it (or its row). */
    async start(ctx: AppContext): Promise<void> {
      background = ctx;
      sql(`CREATE TABLE IF NOT EXISTS ${RETENTION_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 0), used_at INTEGER NOT NULL)`);
      options.wakeups().handle(WAKEUP, expire);
      if (usedAt() === undefined && sql("SELECT 1 FROM execution_do_nodes WHERE kind != 'dir' LIMIT 1").length > 0) await note();
    },

    stop(): void {
      background = undefined;
    },

    /**
     * `env`, each call noted as a use and counted while it runs (a command until it ends, a file
     * operation): the wakeup never deletes the workspace under one. A call that answers synchronously
     * (a helper the environment calls on itself) still does.
     */
    track(env: ExecutionEnv): ExecutionEnv {
      return new Proxy(env, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return function (this: unknown, ...args: unknown[]) {
            active++;
            const noting = note();
            let result: unknown;
            try {
              result = Reflect.apply(value, this, args);
            } catch (error) {
              active--;
              throw error;
            }
            if (!(result instanceof Promise)) {
              active--;
              return result;
            }
            return Promise.all([noting, result])
              .then(([, answer]) => answer)
              .finally(() => active--);
          };
        },
      });
    },
  };
}
