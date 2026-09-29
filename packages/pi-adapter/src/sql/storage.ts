/**
 * Pi's `Storage` for one session, on `storage.sql`: what Pi's `StorageBackedSession` reads and commits
 * through. It keeps nothing in memory but its admission queue: every read and every commit goes to
 * the database, so the session's truth is always the tables (`schema.ts`).
 *
 * Its semantics are those of Pi's `MemoryStorage` and `JsonlStorage`, which the conformance suites
 * check: a commit is one transaction that assigns consecutive sequence numbers from the session's
 * high-water mark, validates ids and parents with Pi's own `validateCommittedWrites`, applies the
 * writes in order, and updates the session's totals; commits run in the order they were admitted;
 * `close` refuses new calls and waits for the commits already admitted.
 *
 * Each read runs in a transaction too, so a record split in parts is never read half-replaced.
 */

import {
  type CommitResult,
  type Context,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type EntryType,
  type ListElement,
  type ListReadOptions,
  prepareStorageCommit,
  resolveListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  validateCommittedWrites,
  type Value,
  type ValueList,
  value,
  type Write,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "@pikit/contracts";
import { batches, CHUNKS, decode, ENTRIES, encode, LISTS, prefixEnd, SESSIONS, USAGE, VALUES, writeParts } from "./schema.ts";

type CommittedWrite = ReturnType<typeof prepareStorageCommit>["writes"][number];

/** A stored record's payload columns. */
interface PayloadRow extends SqlRow {
  seq: number;
  json: string | null;
  parts: number;
}

/** A session's sequence high-water mark and totals. */
interface SessionRow extends SqlRow {
  next_seq: number;
  message_count: number;
  usage_json: string;
}

/** An entry's structure columns: what a branch walk reads, without payloads. */
interface StructureRow extends SqlRow {
  id: string;
  parent_id: string | null;
  seq: number;
  timestamp_ms: number;
  type: string;
  custom_type: string | null;
}

export class SqlStorage implements Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private closing: Promise<void> | undefined;

  constructor(
    private readonly db: SqlDatabase,
    /** The session this storage reads and writes. */
    readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  /**
   * Runs `work` after every commit admitted before it. Commits go through it, and so does a fork of
   * this session, which then copies it at one boundary between two commits.
   */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  async commit(writes: Write[], _context: Context): Promise<CommitResult> {
    this.assertOpen();
    return this.serial(() => this.db.transaction((tx) => this.apply(tx, writes)));
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    return this.read(async (tx) => {
      const found = await this.entriesById(tx, ids);
      const result = new Map<string, Entry>();
      for (const id of ids) {
        const entry = found.get(id);
        if (entry !== undefined) result.set(id, entry);
      }
      return result;
    });
  }

  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    return this.read(async (tx) => {
      const [row] = await tx.query<PayloadRow>(`SELECT seq, json, parts FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key = ?`, [
        this.sessionId,
        address.namespace,
        address.key,
      ]);
      if (row === undefined) return undefined;
      return { address: value<T>(address.namespace, address.key), value: (await decode(tx, this.sessionId, row)) as T, seq: row.seq };
    });
  }

  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    return this.read(async (tx) => {
      // A range, not LIKE: a Durable Object refuses long patterns, and a range uses the primary key.
      const end = prefixEnd(prefix.key);
      const rows = await tx.query<PayloadRow & { address_key: string }>(
        `SELECT address_key, seq, json, parts FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key >= ?${end === undefined ? "" : " AND address_key < ?"} ORDER BY address_key`,
        [this.sessionId, prefix.namespace, prefix.key, ...(end === undefined ? [] : [end])],
      );
      const values: StoredValue<T>[] = [];
      for (const row of rows) {
        values.push({ address: value<T>(prefix.namespace, row.address_key), value: (await decode(tx, this.sessionId, row)) as T, seq: row.seq });
      }
      return values;
    });
  }

  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]> {
    this.assertOpen();
    const { cursor, order, limit } = resolveListReadOptions(options);
    return this.read(async (tx) => {
      const after = cursor === undefined ? "" : order === "asc" ? " AND seq > ?" : " AND seq < ?";
      const rows = await tx.query<PayloadRow>(
        `SELECT seq, json, parts FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ?${after} ORDER BY seq ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
        [this.sessionId, address.namespace, address.key, ...(cursor === undefined ? [] : [cursor.seq]), limit],
      );
      const elements: ListElement<T>[] = [];
      for (const row of rows) elements.push({ seq: row.seq, value: (await decode(tx, this.sessionId, row)) as T });
      return elements;
    });
  }

  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    return this.read(async (tx) => {
      const selected = selectBranch(await branchPath(tx, this.sessionId, query.start), query);
      const found = await this.entriesById(
        tx,
        selected.map((row) => row.id),
      );
      return selected.map((row) => found.get(row.id) as Entry);
    });
  }

  async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
    return this.read(async (tx) => selectBranch(await branchPath(tx, this.sessionId, query.start), query).map(structureOf));
  }

  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    return this.read(async (tx) => {
      const { where, params } = conditions(this.sessionId, { type: query.type, custom_type: query.customType }, query);
      const rows = await tx.query<PayloadRow>(`SELECT seq, json, parts FROM ${ENTRIES} WHERE ${where}`, params);
      const entries: Entry[] = [];
      for (const row of rows) entries.push((await decode(tx, this.sessionId, row)) as Entry);
      return entries;
    });
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    return this.read(async (tx) => {
      const { where, params } = conditions(this.sessionId, {}, query);
      const rows = await tx.query<PayloadRow>(`SELECT seq, json, parts FROM ${USAGE} WHERE ${where}`, params);
      const usage: UsageRow[] = [];
      for (const row of rows) usage.push((await decode(tx, this.sessionId, row)) as UsageRow);
      return usage;
    });
  }

  async getStats(_context: Context): Promise<SessionStats> {
    return this.read((tx) => readStats(tx, this.sessionId));
  }

  /** Refuses new calls at once, and resolves once the commits admitted before it have run. Idempotent. */
  close(_context: Context): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.state = "closing";
    this.closing = this.queue.then(() => {
      this.state = "closed";
    });
    return this.closing;
  }

  /** One commit, inside its transaction: statements only, as `storage.sql` requires. */
  private async apply(tx: SqlStatements, writes: Write[]): Promise<CommitResult> {
    const session = this.sessionId;
    const [row] = await tx.query<SessionRow>(`SELECT next_seq, message_count, usage_json FROM ${SESSIONS} WHERE id = ?`, [session]);
    if (row === undefined) throw new Error(`Unknown session: ${session}`);
    const prepared = prepareStorageCommit(writes, row.next_seq, this.now());
    await validate(tx, session, prepared.writes, row.next_seq);

    let { messageCount, usage } = statsOf(row);
    for (const write of prepared.writes) {
      switch (write.kind) {
        case "entry": {
          const { kind: _kind, ...entry } = write;
          const payload = encode(entry);
          await tx.run(
            `INSERT INTO ${ENTRIES} (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, json, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [session, entry.id, entry.seq, entry.parentId, entry.type, entry.customType ?? null, entry.timestamp, payload.json, payload.parts.length],
          );
          await writeParts(tx, session, entry.seq, payload);
          if (entry.type === "message") messageCount++;
          break;
        }
        case "usage": {
          const { kind: _kind, ...usageRow } = write;
          const payload = encode(usageRow);
          await tx.run(`INSERT INTO ${USAGE} (session_id, id, seq, json, parts) VALUES (?, ?, ?, ?, ?)`, [
            session,
            usageRow.id,
            usageRow.seq,
            payload.json,
            payload.parts.length,
          ]);
          await writeParts(tx, session, usageRow.seq, payload);
          usage = addUsage(usage, usageRow.usage);
          break;
        }
        case "value": {
          const address = [session, write.namespace, write.key];
          // The parts of the value it replaces go with it.
          await tx.run(`DELETE FROM ${CHUNKS} WHERE session_id = ? AND seq IN (SELECT seq FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key = ?)`, [
            session,
            ...address,
          ]);
          if (write.op === "delete") {
            await tx.run(`DELETE FROM ${VALUES} WHERE session_id = ? AND namespace = ? AND address_key = ?`, address);
            break;
          }
          const payload = encode(write.value);
          await tx.run(
            `INSERT INTO ${VALUES} (session_id, namespace, address_key, seq, json, parts) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (session_id, namespace, address_key) DO UPDATE SET seq = excluded.seq, json = excluded.json, parts = excluded.parts`,
            [...address, write.seq, payload.json, payload.parts.length],
          );
          await writeParts(tx, session, write.seq, payload);
          break;
        }
        case "list": {
          const address = [session, write.namespace, write.key];
          if (write.op === "delete") {
            await tx.run(
              `DELETE FROM ${CHUNKS} WHERE session_id = ? AND seq IN (SELECT seq FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ? AND parts > 0)`,
              [session, ...address],
            );
            await tx.run(`DELETE FROM ${LISTS} WHERE session_id = ? AND namespace = ? AND address_key = ?`, address);
            break;
          }
          const payload = encode(write.value);
          await tx.run(`INSERT INTO ${LISTS} (session_id, namespace, address_key, seq, json, parts) VALUES (?, ?, ?, ?, ?, ?)`, [
            ...address,
            write.seq,
            payload.json,
            payload.parts.length,
          ]);
          await writeParts(tx, session, write.seq, payload);
          break;
        }
      }
    }
    const last = prepared.writes.at(-1);
    if (last !== undefined) {
      await tx.run(`UPDATE ${SESSIONS} SET next_seq = ?, message_count = ?, usage_json = ? WHERE id = ?`, [last.seq + 1, messageCount, JSON.stringify(usage), session]);
    }
    return { ...prepared.result, stats: { messageCount, usage } };
  }

  /** The entries among `ids`, by id. */
  private async entriesById(tx: SqlStatements, ids: readonly string[]): Promise<Map<string, Entry>> {
    const found = new Map<string, Entry>();
    for (const batch of batches([...new Set(ids)])) {
      const rows = await tx.query<PayloadRow & { id: string }>(`SELECT id, seq, json, parts FROM ${ENTRIES} WHERE session_id = ? AND id IN (${batch.marks})`, [
        this.sessionId,
        ...batch.ids,
      ]);
      for (const row of rows) found.set(row.id, (await decode(tx, this.sessionId, row)) as Entry);
    }
    return found;
  }

  private read<T>(work: (tx: SqlStatements) => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.db.transaction(work);
  }

  private assertOpen(): void {
    if (this.state !== "open") throw new Error("SQL session storage is closed");
  }
}

/** The session's totals, from its row. */
async function readStats(tx: SqlStatements, session: string): Promise<SessionStats> {
  const [row] = await tx.query<SessionRow>(`SELECT next_seq, message_count, usage_json FROM ${SESSIONS} WHERE id = ?`, [session]);
  if (row === undefined) throw new Error(`Unknown session: ${session}`);
  return statsOf(row);
}

function statsOf(row: SessionRow): SessionStats {
  return { messageCount: row.message_count, usage: JSON.parse(row.usage_json) as Usage };
}

/**
 * The `WHERE … ORDER BY … LIMIT` of a scan by sequence (`scanEntries`, `scanUsage`): the session, the
 * columns in `equal` that are set, the inclusive `fromSeq`/`toSeq` range, the order, and the limit
 * (a negative one is 0, as Pi's in-memory storage treats it).
 */
function conditions(
  session: string,
  equal: Record<string, string | undefined>,
  query: { fromSeq?: number; toSeq?: number; order?: "asc" | "desc"; limit?: number },
): { where: string; params: SqlValue[] } {
  const where = ["session_id = ?"];
  const params: SqlValue[] = [session];
  for (const [column, wanted] of Object.entries(equal)) {
    if (wanted === undefined) continue;
    where.push(`${column} = ?`);
    params.push(wanted);
  }
  if (query.fromSeq !== undefined) {
    where.push("seq >= ?");
    params.push(query.fromSeq);
  }
  if (query.toSeq !== undefined) {
    where.push("seq <= ?");
    params.push(query.toSeq);
  }
  let sql = `${where.join(" AND ")} ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"}`;
  if (query.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(Math.max(0, Math.trunc(query.limit)));
  }
  return { where: sql, params };
}

/** Pi's checks of a commit (new ids, known parents), over the ids it names that the tables hold. */
async function validate(tx: SqlStatements, session: string, writes: CommittedWrite[], firstSeq: number): Promise<void> {
  const ids = new Set<string>();
  const referenced = new Set<string>();
  for (const write of writes) {
    if (write.kind !== "entry" && write.kind !== "usage") continue;
    ids.add(write.id);
    referenced.add(write.id);
    if (write.kind === "entry" && write.parentId !== null) referenced.add(write.parentId);
  }
  const entries = await existing(tx, ENTRIES, session, [...referenced]);
  const usage = await existing(tx, USAGE, session, [...ids]);
  validateCommittedWrites(writes, firstSeq, {
    hasEntryOrUsageId: (id) => entries.has(id) || usage.has(id),
    hasEntryId: (id) => entries.has(id),
  });
}

async function existing(tx: SqlStatements, table: string, session: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const batch of batches(ids)) {
    const rows = await tx.query<{ id: string }>(`SELECT id FROM ${table} WHERE session_id = ? AND id IN (${batch.marks})`, [session, ...batch.ids]);
    for (const row of rows) found.add(row.id);
  }
  return found;
}

/**
 * The entries from `start` to the root, newest first, as structure only: one indexed lookup per
 * ancestor, and no payload read. Throws when `start` is unknown or an ancestor is missing.
 */
export async function branchPath(tx: SqlStatements, session: string, start: string): Promise<StructureRow[]> {
  const rows = await tx.query<StructureRow & { depth: number }>(
    `WITH RECURSIVE path (id, parent_id, seq, timestamp_ms, type, custom_type, depth) AS (
       SELECT id, parent_id, seq, timestamp_ms, type, custom_type, 0 FROM ${ENTRIES} WHERE session_id = ? AND id = ?
       UNION ALL
       SELECT e.id, e.parent_id, e.seq, e.timestamp_ms, e.type, e.custom_type, path.depth + 1
       FROM ${ENTRIES} e JOIN path ON e.session_id = ? AND e.id = path.parent_id
     )
     SELECT id, parent_id, seq, timestamp_ms, type, custom_type, depth FROM path ORDER BY depth`,
    [session, start, session],
  );
  if (rows.length === 0) throw new Error(`Unknown branch start: ${start}`);
  if (rows.at(-1)?.parent_id !== null) throw new Error("Corrupt branch: missing parent");
  return rows;
}

/**
 * A branch scan's selection over its path, as Pi's in-memory storage makes it: order, then stops
 * (inclusive), then filters and the cursor, then the limit.
 */
function selectBranch(path: StructureRow[], query: StorageBranchScan): StructureRow[] {
  const ordered = query.order === "oldestFirst" ? [...path].reverse() : path;
  const stopped: StructureRow[] = [];
  for (const row of ordered) {
    stopped.push(row);
    if (row.id === query.stopAtId || row.type === query.stopAtType) break;
  }
  const filtered = stopped.filter(
    (row) =>
      (query.type === undefined || row.type === query.type) &&
      (query.customType === undefined || (row.custom_type ?? undefined) === query.customType) &&
      (query.cursor === undefined || (query.order === "oldestFirst" ? row.seq > query.cursor.seq : row.seq < query.cursor.seq)),
  );
  return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
}

function structureOf(row: StructureRow): EntryStructure {
  return {
    id: row.id,
    parentId: row.parent_id,
    seq: row.seq,
    timestamp: row.timestamp_ms,
    type: row.type as EntryType,
    ...(row.custom_type === null ? {} : { customType: row.custom_type }),
  };
}

/** Pi's `addUsage` (not exported by Pi): the session totals after one more usage row. */
function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined ? {} : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined ? {} : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

/** An empty ledger, as a new session's totals. */
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
