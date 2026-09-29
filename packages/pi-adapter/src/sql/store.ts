/**
 * Pi sessions on `storage.sql` (SPEC §4, C5): a `SessionRepo` whose sessions are rows of the app's SQL
 * database, so the same store runs on a server (SQLite) and in a Cloudflare Durable Object (its SQL).
 * Pi's `StorageBackedSession` is the session; `SqlStorage` (storage.ts) is what it stores through.
 *
 * - **One open handle per session in this process**, as Pi's repositories enforce: `open` refuses a
 *   session already open, and `delete` one that is. A session belongs to one process (SPEC §7.2):
 *   one server over its database, or the Durable Object that owns the conversation. Two processes
 *   opening one session is not detected; each commit is still one transaction, so neither can
 *   corrupt the other's sequence numbers, but their runs would interleave.
 * - **Ids are reserved at the call**, before any await, so of a `create` and a `fork` racing for one
 *   new id, the first called wins; the database's primary key backs it across processes.
 * - **A fork is one transaction** that copies rows with SQL (`INSERT … SELECT`), so a large session
 *   never passes through memory. It follows Pi's fork policy (`projectForkCurrentStateWrite`), keeps
 *   every copied record's sequence number and the source's high-water mark, and excludes usage. A
 *   source open in this process is copied between two of its commits.
 */

import {
  type Context,
  type ForkOptions,
  projectForkCurrentStateWrite,
  type Session,
  type SessionCreateOptions,
  type SessionMetadata,
  StorageBackedSession,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import type { SqlDatabase, SqlRow, SqlStatements } from "@pikit/contracts";
import type { SessionStore } from "../types.ts";
import { batches, CHUNKS, decode, ENTRIES, encode, LISTS, migrate, SESSIONS, USAGE, VALUES, writeParts } from "./schema.ts";
import { branchPath, emptyUsage, SqlStorage } from "./storage.ts";

/** The storage version of every session this store writes (Pi's repositories are at 1 too). */
const STORAGE_VERSION = 1;

export interface SqlSessionStoreOptions {
  /**
   * The working directory recorded in a session created without one. Pi extensions read it as
   * `ctx.cwd`; without it, a session records none.
   */
  cwd?: string;
  /** The clock of `createdAt` and of entry timestamps. Default `Date.now`. */
  now?: () => number;
}

export interface SqlSessionCreateOptions extends SessionCreateOptions {
  cwd?: string;
}

/** A `sessions.store` on `storage.sql`. */
export interface SqlSessionStore extends SessionStore {
  create(options: SqlSessionCreateOptions, context: Context): Promise<Session>;
  open(metadata: SessionMetadata, context: Context): Promise<Session>;
  /** Every session, newest first. */
  list(options: void | undefined, context: Context): Promise<SessionMetadata[]>;
  delete(metadata: SessionMetadata, context: Context): Promise<void>;
  fork(source: SessionMetadata, options: ForkOptions, context: Context): Promise<Session>;
  find(id: string, context: Context): Promise<SessionMetadata | undefined>;
  /** Creates or upgrades the tables. Run it once before anything else, at start. */
  migrate(): Promise<void>;
  /** Refuses new calls and closes every session still open here, waiting for their commits. */
  close(context: Context): Promise<void>;
}

interface SessionRow extends SqlRow {
  id: string;
  created_at: number;
  storage_version: number;
  cwd: string | null;
  parent_session_id: string | null;
  next_seq: number;
}

/** A value no stored record holds: what a fork passes through Pi's policy to learn if a row is kept as it is. */
const KEEP = Symbol("kept as stored");

export function createSqlSessionStore(db: SqlDatabase, options: SqlSessionStoreOptions = {}): SqlSessionStore {
  const now = options.now ?? Date.now;
  const open = new Map<string, { storage: SqlStorage; session: Session }>();
  const reserved = new Set<string>();
  let closing: Promise<void> | undefined;

  const assertOpen = () => {
    if (closing !== undefined) throw new Error("SQL session store is closed");
  };
  const reserve = (id: string) => {
    if (reserved.has(id) || open.has(id)) throw new Error(`Session already exists: ${id}`);
    reserved.add(id);
  };
  const find = async (id: string): Promise<SessionMetadata | undefined> => {
    const [row] = await db.query<SessionRow>(`SELECT * FROM ${SESSIONS} WHERE id = ?`, [id]);
    return row === undefined ? undefined : metadataOf(row);
  };
  /** The one open handle on `metadata`'s session. */
  const publish = (metadata: SessionMetadata): Session => {
    if (open.has(metadata.id)) throw new Error(`Session is already open: ${metadata.id}`);
    const storage = new SqlStorage(db, metadata.id, now);
    const session = new StorageBackedSession(metadata, storage, {
      onClose: () => {
        if (open.get(metadata.id)?.storage === storage) open.delete(metadata.id);
      },
    });
    open.set(metadata.id, { storage, session });
    return session;
  };

  return {
    migrate: () => migrate(db),

    async create(createOptions, _context) {
      assertOpen();
      const createdAt = now();
      const id = createOptions.id ?? uuidv7(createdAt);
      reserve(id);
      try {
        const cwd = createOptions.cwd ?? options.cwd;
        const metadata: SessionMetadata = {
          id,
          createdAt,
          storageVersion: STORAGE_VERSION,
          ...(cwd !== undefined && { cwd }),
          ...(createOptions.parentSessionId !== undefined && { parentSessionId: createOptions.parentSessionId }),
        };
        const { changes } = await db.run(
          `INSERT INTO ${SESSIONS} (id, created_at, storage_version, cwd, parent_session_id, next_seq, message_count, usage_json)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?) ON CONFLICT (id) DO NOTHING`,
          [id, createdAt, STORAGE_VERSION, cwd ?? null, createOptions.parentSessionId ?? null, JSON.stringify(emptyUsage())],
        );
        if (changes === 0) throw new Error(`Session already exists: ${id}`);
        return publish(metadata);
      } finally {
        reserved.delete(id);
      }
    },

    async open(metadata, _context) {
      assertOpen();
      if (open.has(metadata.id)) throw new Error(`Session is already open: ${metadata.id}`);
      const stored = await find(metadata.id);
      if (stored === undefined) throw new Error(`Unknown session: ${metadata.id}`);
      if (stored.storageVersion !== STORAGE_VERSION) throw new Error(`Session ${metadata.id} uses unsupported storage version ${stored.storageVersion}`);
      return publish(stored);
    },

    async list(_options, _context) {
      assertOpen();
      return (await db.query<SessionRow>(`SELECT * FROM ${SESSIONS} ORDER BY created_at DESC, id`)).map(metadataOf);
    },

    async find(id, _context) {
      assertOpen();
      return find(id);
    },

    async delete(metadata, _context) {
      assertOpen();
      if (open.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
      await db.transaction(async (tx) => {
        const { changes } = await tx.run(`DELETE FROM ${SESSIONS} WHERE id = ?`, [metadata.id]);
        if (changes === 0) throw new Error(`Unknown session: ${metadata.id}`);
        for (const table of [ENTRIES, USAGE, VALUES, LISTS, CHUNKS]) {
          await tx.run(`DELETE FROM ${table} WHERE session_id = ?`, [metadata.id]);
        }
      });
    },

    async fork(source, forkOptions, _context) {
      assertOpen();
      const createdAt = now();
      const id = forkOptions.id ?? uuidv7(createdAt);
      reserve(id);
      try {
        const copy = () => db.transaction((tx) => copySession(tx, source.id, { id, createdAt }, forkOptions));
        // A source open here is copied between two of its commits: after those admitted before this call.
        const sourceStorage = open.get(source.id)?.storage;
        return publish(await (sourceStorage === undefined ? copy() : sourceStorage.serial(copy)));
      } finally {
        reserved.delete(id);
      }
    },

    close(context) {
      closing ??= Promise.all([...open.values()].map(({ session }) => session.close(context))).then(() => {});
      return closing;
    },
  };
}

function metadataOf(row: SessionRow): SessionMetadata {
  return {
    id: row.id,
    createdAt: row.created_at,
    storageVersion: row.storage_version,
    ...(row.cwd !== null && { cwd: row.cwd }),
    ...(row.parent_session_id !== null && { parentSessionId: row.parent_session_id }),
  };
}

type ForkPlan = Parameters<typeof projectForkCurrentStateWrite>[1];

/**
 * The new session `destination`, forked from `sourceId`, inside one transaction: the entries the
 * fork selects, the values and lists Pi's fork policy keeps (some rewritten, such as a lane's state,
 * which starts idle), and no usage. Throws, copying nothing, when the fork is invalid.
 */
async function copySession(tx: SqlStatements, sourceId: string, destination: { id: string; createdAt: number }, options: ForkOptions): Promise<SessionMetadata> {
  const [source] = await tx.query<SessionRow>(`SELECT * FROM ${SESSIONS} WHERE id = ?`, [sourceId]);
  if (source === undefined) throw new Error(`Unknown session: ${sourceId}`);
  const { plan, selected } = options.scope === "tree" ? { plan: { scope: "tree" } as ForkPlan, selected: undefined } : await selectBranch(tx, sourceId, options);
  const isEntryCopied = (entryId: string) => selected === undefined || selected.has(entryId);
  const to = destination.id;

  const metadata = metadataOf({ ...source, id: to, created_at: destination.createdAt, storage_version: STORAGE_VERSION, parent_session_id: sourceId });
  const { changes } = await tx.run(
    `INSERT INTO ${SESSIONS} (id, created_at, storage_version, cwd, parent_session_id, next_seq, message_count, usage_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO NOTHING`,
    [to, destination.createdAt, STORAGE_VERSION, source.cwd, sourceId, source.next_seq, JSON.stringify(emptyUsage())],
  );
  if (changes === 0) throw new Error(`Session already exists: ${to}`);

  // Entries, with their sequence numbers and timestamps, then the parts of those stored in parts.
  const copyEntries = `INSERT INTO ${ENTRIES} (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, json, parts)
    SELECT ?, id, seq, parent_id, type, custom_type, timestamp_ms, json, parts FROM ${ENTRIES} WHERE session_id = ?`;
  if (selected === undefined) await tx.run(copyEntries, [to, sourceId]);
  else for (const batch of batches([...selected])) await tx.run(`${copyEntries} AND id IN (${batch.marks})`, [to, sourceId, ...batch.ids]);
  await tx.run(
    `INSERT INTO ${CHUNKS} (session_id, seq, part, text) SELECT ?, seq, part, text FROM ${CHUNKS}
     WHERE session_id = ? AND seq IN (SELECT seq FROM ${ENTRIES} WHERE session_id = ? AND parts > 0)`,
    [to, sourceId, to],
  );
  await tx.run(`UPDATE ${SESSIONS} SET message_count = (SELECT COUNT(*) FROM ${ENTRIES} WHERE session_id = ? AND type = 'message') WHERE id = ?`, [to, to]);

  // Values: Pi's policy decides, per address, whether each is dropped, kept or rewritten.
  const values = await tx.query<{ namespace: string; address_key: string; seq: number; parts: number }>(
    `SELECT namespace, address_key, seq, parts FROM ${VALUES} WHERE session_id = ?`,
    [sourceId],
  );
  for (const row of values) {
    const projected = projectForkCurrentStateWrite(
      { kind: "value", op: "set", seq: row.seq, namespace: row.namespace, key: row.address_key, value: KEEP },
      plan,
      isEntryCopied,
    );
    if (projected === undefined) continue;
    const address = [row.namespace, row.address_key];
    if (projected.value === KEEP) {
      await tx.run(
        `INSERT INTO ${VALUES} (session_id, namespace, address_key, seq, json, parts)
         SELECT ?, namespace, address_key, seq, json, parts FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key = ?`,
        [to, sourceId, ...address],
      );
      if (row.parts > 0) {
        await tx.run(`INSERT INTO ${CHUNKS} (session_id, seq, part, text) SELECT ?, seq, part, text FROM ${CHUNKS} WHERE session_id = ? AND seq = ?`, [
          to,
          sourceId,
          row.seq,
        ]);
      }
    } else {
      const payload = encode(projected.value);
      await tx.run(`INSERT INTO ${VALUES} (session_id, namespace, address_key, seq, json, parts) VALUES (?, ?, ?, ?, ?, ?)`, [
        to,
        ...address,
        row.seq,
        payload.json,
        payload.parts.length,
      ]);
      await writeParts(tx, to, row.seq, payload);
    }
  }

  // Lists: the policy depends on a list's address, never on an element, so it is asked once per list.
  const lists = await tx.query<{ namespace: string; address_key: string }>(`SELECT DISTINCT namespace, address_key FROM ${LISTS} WHERE session_id = ?`, [sourceId]);
  for (const row of lists) {
    const projected = projectForkCurrentStateWrite(
      { kind: "list", op: "append", seq: 0, namespace: row.namespace, key: row.address_key, value: KEEP },
      plan,
      isEntryCopied,
    );
    if (projected === undefined) continue;
    const address = [row.namespace, row.address_key];
    if (projected.value === KEEP) {
      await tx.run(
        `INSERT INTO ${LISTS} (session_id, namespace, address_key, seq, json, parts)
         SELECT ?, namespace, address_key, seq, json, parts FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ?`,
        [to, sourceId, ...address],
      );
      await tx.run(
        `INSERT INTO ${CHUNKS} (session_id, seq, part, text) SELECT ?, seq, part, text FROM ${CHUNKS}
         WHERE session_id = ? AND seq IN (SELECT seq FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ? AND parts > 0)`,
        [to, sourceId, sourceId, ...address],
      );
    } else {
      const payload = encode(projected.value);
      const elements = await tx.query<{ seq: number }>(`SELECT seq FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ?`, [
        sourceId,
        ...address,
      ]);
      for (const { seq } of elements) {
        await tx.run(`INSERT INTO ${LISTS} (session_id, namespace, address_key, seq, json, parts) VALUES (?, ?, ?, ?, ?, ?)`, [
          to,
          ...address,
          seq,
          payload.json,
          payload.parts.length,
        ]);
        await writeParts(tx, to, seq, payload);
      }
    }
  }
  return metadata;
}

/**
 * A branch fork's plan and the entries it copies, as Pi's `selectBranchFork` makes them (not
 * exported by Pi): the path from the branch's tip to the root, from the requested entry (`at`) or
 * its parent (`before`) down. The branch must be a configured AgentLane.
 */
async function selectBranch(
  tx: SqlStatements,
  sourceId: string,
  options: Extract<ForkOptions, { scope: "branch" }>,
): Promise<{ plan: ForkPlan; selected: Set<string> }> {
  const stored = async (namespace: string) => {
    const [row] = await tx.query<{ seq: number; json: string | null; parts: number }>(
      `SELECT seq, json, parts FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key = ?`,
      [sourceId, namespace, options.branch],
    );
    return row;
  };
  const tipRow = await stored("pi.branch.tip");
  if (tipRow === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
  const tip = (await decode(tx, sourceId, tipRow)) as string | null;
  const requested = options.entryId ?? tip;
  const selected = new Set<string>();
  let found = requested === null;
  let destinationTip: string | null = null;
  for (const entry of tip === null ? [] : await branchPath(tx, sourceId, tip)) {
    if (entry.id === requested) {
      found = true;
      destinationTip = options.position === "before" ? entry.parent_id : entry.id;
      if (options.position !== "before") selected.add(entry.id);
    } else if (found) {
      selected.add(entry.id);
    }
  }
  if (!found) throw new Error(`Fork entry ${requested} is not on source branch ${JSON.stringify(options.branch)}`);
  if ((await stored("pi.lane.config")) === undefined || (await stored("pi.lane.state")) === undefined) {
    throw new Error(`Source branch ${JSON.stringify(options.branch)} is not a configured AgentLane`);
  }
  return { plan: { scope: "branch", branch: options.branch, destinationTip }, selected };
}
