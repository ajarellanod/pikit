/**
 * The directory itself: `conversations.directory`'s rows and queries over `storage.sql` (`tables.ts`),
 * where the directory is (a server's App, the index object on Cloudflare). It takes viewers and queries
 * already checked (`client.ts` and `calls.ts` run the contract's parsers on arrival) and the grants
 * the caller's App computed (`audienceGrants`): trusted code's, as the contract says.
 *
 * - **Who sees** (`roleOn`): operators and components every recorded conversation; people one that is
 *   its key's current, not delegated, not deleted, with activity people see, whose owner is among their
 *   principals or whose space a grant names. Without grants for a conversation of a space that is not
 *   theirs, an answer is `{ needs: space }`: the caller checks that one space fresh and asks again.
 * - **Lists** are one keyset query (`ORDER BY activity DESC, key DESC, conversation DESC`, SQL's
 *   `BINARY`: `compareDirectoryOrder`) for a viewer's own, and one per chunk of grant spaces (each
 *   query under 100 bound parameters, Cloudflare's limit), merged.
 * - **Activity** (`seen`): a maximum; people's order (`shown_activity`) never moves for an operator's;
 *   an archived conversation is listed again by activity people see after it was archived.
 */

import type { AppContext } from "@pikit/core";
import {
  type Author,
  afterCursor,
  cleanTitle,
  compareDirectoryOrder,
  type DirectoryEntry,
  DirectoryError,
  type DirectoryListState,
  type DirectoryQuery,
  type DirectoryRole,
  directoryCursor,
  type EntryRef,
  type EntryState,
  likePattern,
  type Page,
  type Principal,
  parseAuthor,
  parseDirectoryCursor,
  permissionsOf,
  principalKey,
  type SqlDatabase,
  type SqlStatements,
  type SqlValue,
  stillHidden,
  titleApplies,
  type TitleSource,
  UNREAD_MAX,
  type Viewer,
  type ViewerChange,
  viewerAuthor,
  viewerKey,
  viewerPrincipals,
} from "@pikit/contracts";
import { ACTIVITY, ACTIVITY_KEPT, ENTRIES, VIEWERS } from "./tables.ts";
import type { Update } from "./update.ts";

/** A grant as the directory takes it: a space and the role there (`AudienceGrant` without its source). */
export type Grant = { space: string; role: "member" | "owner" };

/** An answer about one conversation: its entry, nothing (not seen: `not_found`), or the space whose grants it needs. */
export type Outcome = { entry?: DirectoryEntry; needs?: string };

export type ParsedQuery = DirectoryQuery & { limit: number; state: DirectoryListState };

export interface DirectoryStore {
  seen(updates: readonly Update[]): Promise<void>;
  list(viewer: Viewer, query: ParsedQuery, grants: readonly Grant[]): Promise<Page<DirectoryEntry>>;
  count(viewer: Viewer, spaces: readonly string[], grants: readonly Grant[]): Promise<Record<string, number>>;
  access(viewer: Viewer, ref: { key: string; conversationId?: string }, grants: readonly Grant[] | undefined): Promise<Outcome>;
  rename(viewer: Viewer, ref: EntryRef, title: string, grants: readonly Grant[] | undefined): Promise<Outcome>;
  setState(viewer: Viewer, ref: EntryRef, state: EntryState, grants: readonly Grant[] | undefined, ctx: AppContext): Promise<Outcome>;
  mine(viewer: Viewer, ref: EntryRef, change: ViewerChange, grants: readonly Grant[] | undefined): Promise<Outcome>;
  title(ref: EntryRef, title: { text: string; source: "first" | "model" }): Promise<void>;
}

export interface DirectoryOptions {
  db(): Promise<SqlDatabase>;
  now(): number;
  /**
   * Resets `key` in its conversation's App, when `conversationId` is still its current one
   * (`conversations.registry.reset`): the updates that says (the previous one not current, the new one
   * recorded), applied before the delete resolves.
   */
  reset(key: string, conversationId: string, ctx: AppContext): Promise<Update[]>;
}

type Row = {
  key: string;
  conversation: string;
  channel: string | null;
  agent: string | null;
  space: string | null;
  owner: string | null;
  delegated: number;
  is_current: number;
  created_at: number;
  last_activity: number;
  shown_activity: number;
  busy: number;
  seq: number;
  title: string | null;
  title_source: string | null;
  title_at: number | null;
  state: string;
  state_at: number | null;
  state_by: string | null;
  hidden_at: number | null;
  read_at: number | null;
  name: string | null;
};

/** The most bound parameters one query takes (Cloudflare's SQL: 100). */
const PARAMS_MAX = 99;
/** Spaces per chunk of a people viewer's list, at most. */
const CHUNK_MAX = 90;

/** The principal a `principalKey` names (its channel is URI-encoded, its id is the rest). */
function principalOf(key: string): Principal {
  const at = key.indexOf(":");
  return { channel: decodeURIComponent(key.slice(0, at)), id: key.slice(at + 1) };
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
const bad = (code: "not_found" | "forbidden" | "invalid", message: string): never => {
  throw new DirectoryError(code, message);
};

/** The activity `viewer` sees of a row: people's never moves for an operator's. */
const activityFor = (viewer: Viewer, row: Pick<Row, "last_activity" | "shown_activity">): number => Number(viewer.kind === "people" ? row.shown_activity : row.last_activity);

/** The best role grants give in `space`. */
function grantRole(grants: readonly Grant[], space: string): DirectoryRole | undefined {
  const ofSpace = grants.filter((grant) => grant.space === space);
  if (ofSpace.some((grant) => grant.role === "owner")) return "space-owner";
  return ofSpace.length > 0 ? "member" : undefined;
}

/** Why `viewer` sees `row` (`"needs"`: only its space's grants can say), or `undefined` when it does not. */
function roleOn(viewer: Viewer, row: Row, grants: readonly Grant[] | undefined): DirectoryRole | "needs" | undefined {
  if (row.channel === null) return undefined;
  if (viewer.kind === "operator" || viewer.kind === "component") return viewer.kind;
  if (Number(row.is_current) !== 1 || Number(row.delegated) === 1 || Number(row.shown_activity) <= 0 || row.state === "deleted") return undefined;
  if (row.owner !== null && viewerPrincipals(viewer).some((each) => principalKey(each) === row.owner)) return "owner";
  if (row.space === null) return undefined;
  if (grants === undefined) return "needs";
  return grantRole(grants, row.space);
}

export function createDirectoryStore(options: DirectoryOptions): DirectoryStore {
  const { db, now } = options;

  /** `viewer`'s `unread` on `row`: activity it sees after its mark, by anyone not among its principals. */
  const unreadOf = async (database: SqlStatements, viewer: Viewer, row: Row): Promise<number> => {
    const mine = viewerPrincipals(viewer).map(principalKey);
    const [count] = await database.query<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM ${ACTIVITY} WHERE key = ? AND conversation = ? AND at > ?${viewer.kind === "people" ? " AND shown = 1" : ""}` +
        `${mine.length > 0 ? ` AND by NOT IN (${marks(mine.length)})` : ""} LIMIT ${UNREAD_MAX}) counted`,
      [row.key, row.conversation, row.read_at === null ? -1 : Number(row.read_at), ...mine],
    );
    return Math.min(Number(count?.n ?? 0), UNREAD_MAX);
  };

  /** `row` as `viewer` (with `role`) sees it. */
  const entryOf = async (database: SqlStatements, viewer: Viewer, row: Row, role: DirectoryRole): Promise<DirectoryEntry> => {
    const lastActivity = activityFor(viewer, row);
    const entry: DirectoryEntry = {
      key: row.key,
      conversationId: row.conversation,
      channel: row.channel ?? "",
      agent: row.agent ?? "",
      ...(row.space !== null && { space: row.space }),
      ...(row.owner !== null && { owner: principalOf(row.owner) }),
      current: Number(row.is_current) === 1,
      createdAt: Number(row.created_at),
      lastActivity,
      busy: Number(row.busy) === 1,
      ...(row.title !== null && { title: row.title }),
      ...(row.title_source !== null && { titleSource: row.title_source as TitleSource }),
      state: row.state as EntryState,
      ...(row.state_at !== null && { stateAt: Number(row.state_at) }),
      ...(row.state_by !== null && { stateBy: parseAuthor(JSON.parse(row.state_by)) as Author }),
      role,
      may: permissionsOf(role),
    };
    if (viewerKey(viewer) !== undefined) {
      const hiddenAt = row.hidden_at === null ? undefined : Number(row.hidden_at);
      const hidden = stillHidden(hiddenAt, lastActivity);
      entry.mine = {
        hidden,
        ...(hidden && hiddenAt !== undefined && { hiddenAt }),
        ...(row.read_at !== null && { readAt: Number(row.read_at) }),
        ...(row.name !== null && { name: row.name }),
        unread: await unreadOf(database, viewer, row),
      };
    }
    return entry;
  };

  /** The row of `ref` (with no conversation id: its key's current one) with `viewer`'s own state. */
  const rowOf = async (database: SqlStatements, viewer: Viewer, ref: { key: string; conversationId?: string }): Promise<Row | undefined> => {
    const own = viewerKey(viewer);
    const join = own === undefined ? "" : ` LEFT JOIN ${VIEWERS} v ON v.viewer = ? AND v.key = e.key AND v.conversation = e.conversation`;
    const columns = own === undefined ? "NULL AS hidden_at, NULL AS read_at, NULL AS name" : "v.hidden_at AS hidden_at, v.read_at AS read_at, v.name AS name";
    const where = ref.conversationId === undefined ? "e.key = ? AND e.is_current = 1 AND e.channel IS NOT NULL ORDER BY e.created_at DESC, e.conversation DESC LIMIT 1" : "e.key = ? AND e.conversation = ?";
    const [row] = await database.query<Row>(`SELECT e.*, ${columns} FROM ${ENTRIES} e${join} WHERE ${where}`, [
      ...(own === undefined ? [] : [own]),
      ref.key,
      ...(ref.conversationId === undefined ? [] : [ref.conversationId]),
    ]);
    return row;
  };

  const access = async (database: SqlStatements, viewer: Viewer, ref: { key: string; conversationId?: string }, grants: readonly Grant[] | undefined): Promise<{ row: Row; role: DirectoryRole } | { needs: string } | undefined> => {
    const row = await rowOf(database, viewer, ref);
    if (row === undefined) return undefined;
    const role = roleOn(viewer, row, grants);
    if (role === "needs") return { needs: row.space as string };
    return role === undefined ? undefined : { row, role };
  };

  /** `ref` as `viewer` sees it, or `{ needs }`; throws `not_found` when it does not. */
  const seenOr404 = async (database: SqlStatements, viewer: Viewer, ref: EntryRef, grants: readonly Grant[] | undefined) => {
    const seen = await access(database, viewer, ref, grants);
    if (seen === undefined) return bad("not_found", "no such conversation");
    return seen;
  };

  /** Applies one update (see `update.ts`), in `tx`. */
  const apply = async (tx: SqlStatements, update: Update): Promise<void> => {
    const where = "WHERE key = ? AND conversation = ?";
    const ref = [update.key, update.conversationId];
    await tx.run(`INSERT INTO ${ENTRIES} (key, conversation) VALUES (?, ?) ON CONFLICT (key, conversation) DO NOTHING`, ref);
    const { place } = update;
    if (place !== undefined) {
      await tx.run(
        `UPDATE ${ENTRIES} SET channel = ?, agent = COALESCE(agent, ?), space = ?, owner = ?, delegated = ?, is_current = CASE WHEN ? = 1 THEN is_current ELSE 0 END, created_at = ? ${where} AND channel IS NULL`,
        [place.channel, place.agent, place.space ?? null, place.owner === undefined ? null : principalKey(place.owner), place.delegated ? 1 : 0, place.current ? 1 : 0, place.at, ...ref],
      );
    }
    if (update.busy !== undefined || update.agent !== undefined) {
      await tx.run(`UPDATE ${ENTRIES} SET seq = ?, busy = COALESCE(?, busy), agent = COALESCE(?, agent) ${where} AND seq < ?`, [
        update.seq,
        update.busy === undefined ? null : update.busy ? 1 : 0,
        update.agent ?? null,
        ...ref,
        update.seq,
      ]);
    }
    if (update.current === false) await tx.run(`UPDATE ${ENTRIES} SET is_current = 0 ${where}`, ref);
    let last = update.touched ?? 0;
    let shown = update.touched ?? 0;
    let unarchive = 0;
    let added = false;
    for (const each of update.activity ?? []) {
      const { changes } = await tx.run(`INSERT INTO ${ACTIVITY} (key, conversation, id, at, by, shown) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key, conversation, id) DO NOTHING`, [
        ...ref,
        each.id,
        each.at,
        each.by,
        each.shown ? 1 : 0,
      ]);
      if (changes === 0) continue;
      added = true;
      last = Math.max(last, each.at);
      if (each.shown) {
        shown = Math.max(shown, each.at);
        unarchive = Math.max(unarchive, each.at);
      }
    }
    if (added) {
      await tx.run(
        `DELETE FROM ${ACTIVITY} ${where} AND id NOT IN (SELECT id FROM ${ACTIVITY} ${where} ORDER BY at DESC, id DESC LIMIT ${ACTIVITY_KEPT})`,
        [...ref, ...ref],
      );
    }
    if (last > 0 || shown > 0) {
      // Every SET reads the row as it was: an archived one comes back with activity people see after it was archived.
      const back = "state = 'archived' AND ? > COALESCE(state_at, 0)";
      await tx.run(
        `UPDATE ${ENTRIES} SET last_activity = CASE WHEN last_activity < ? THEN ? ELSE last_activity END, shown_activity = CASE WHEN shown_activity < ? THEN ? ELSE shown_activity END, ` +
          `state = CASE WHEN ${back} THEN 'listed' ELSE state END, state_at = CASE WHEN ${back} THEN NULL ELSE state_at END, state_by = CASE WHEN ${back} THEN NULL ELSE state_by END ${where}`,
        [last, last, shown, shown, unarchive, unarchive, unarchive, ...ref],
      );
    }
    if (update.title !== undefined) await titled(tx, update, update.title);
  };

  /** Writes `title` unless a title of a higher source is there (an equal one only by a newer one). */
  const titled = async (tx: SqlStatements, ref: { key: string; conversationId: string }, title: { text: string; source: TitleSource; at: number }): Promise<void> => {
    const cleaned = cleanTitle(title.text);
    if (cleaned === undefined) return;
    const [row] = await tx.query<{ title_source: string | null; title_at: number | null }>(`SELECT title_source, title_at FROM ${ENTRIES} WHERE key = ? AND conversation = ?`, [
      ref.key,
      ref.conversationId,
    ]);
    const current = (row?.title_source ?? undefined) as TitleSource | undefined;
    if (!titleApplies(current, title.source)) return;
    if (current === title.source && title.source !== "rename" && Number(row?.title_at ?? 0) > title.at) return;
    await tx.run(`UPDATE ${ENTRIES} SET title = ?, title_source = ?, title_at = ?, title_search = ? WHERE key = ? AND conversation = ?`, [
      cleaned,
      title.source,
      title.at,
      cleaned.toLowerCase(),
      ref.key,
      ref.conversationId,
    ]);
  };

  /** The parts of a list's query every chunk shares. */
  const listing = (viewer: Viewer, query: ParsedQuery) => {
    const people = viewer.kind === "people";
    const act = people ? "e.shown_activity" : "e.last_activity";
    const own = viewerKey(viewer);
    const params: SqlValue[] = [];
    let from = `${ENTRIES} e`;
    if (own !== undefined) {
      from += ` LEFT JOIN ${VIEWERS} v ON v.viewer = ? AND v.key = e.key AND v.conversation = e.conversation`;
      params.push(own);
    }
    const columns = own === undefined ? "NULL AS hidden_at, NULL AS read_at, NULL AS name" : "v.hidden_at AS hidden_at, v.read_at AS read_at, v.name AS name";
    const hidden = own === undefined ? "(1 = 0)" : `(v.hidden_at IS NOT NULL AND ${act} <= v.hidden_at)`;
    const where = ["e.channel IS NOT NULL", `${act} > 0`];
    if (people) where.push("e.is_current = 1", "e.delegated = 0", "e.state <> 'deleted'");
    if (query.state === "deleted") where.push("e.state = 'deleted'");
    else if (query.state === "hidden") where.push("e.state <> 'deleted'", hidden);
    else {
      where.push("e.state = ?", `NOT ${hidden}`);
      params.push(query.state);
    }
    if (query.space !== undefined) {
      where.push("e.space = ?");
      params.push(query.space);
    }
    if (query.channels !== undefined) {
      where.push(`e.channel IN (${marks(query.channels.length)})`);
      params.push(...query.channels);
    }
    if (query.owned === true) {
      const keys = viewerPrincipals(viewer).map(principalKey);
      where.push(`e.owner IN (${marks(keys.length)})`);
      params.push(...keys);
    }
    if (query.q !== undefined) {
      const like = likePattern(query.q);
      const texts = ["e.title_search LIKE ? ESCAPE '\\'"];
      if (own !== undefined) texts.push("v.name_search LIKE ? ESCAPE '\\'");
      if (!people) texts.push("lower(e.key) LIKE ? ESCAPE '\\'");
      where.push(`(${texts.join(" OR ")})`);
      params.push(...texts.map(() => like));
    }
    if (query.cursor !== undefined) {
      const after = parseDirectoryCursor(query.cursor);
      where.push(`(${act} < ? OR (${act} = ? AND (e.key < ? OR (e.key = ? AND e.conversation < ?))))`);
      params.push(after.lastActivity, after.lastActivity, after.key, after.key, after.conversationId);
    }
    return { act, from, columns, where, params };
  };

  /** A people viewer's visibility clauses: their own, then the granted spaces in chunks that fit `room` parameters. */
  const visibility = (viewer: Viewer, query: ParsedQuery, grants: readonly Grant[], room: number): { clause: string; params: SqlValue[] }[] => {
    const keys = viewerPrincipals(viewer).map(principalKey);
    const clauses = [{ clause: `e.owner IN (${marks(keys.length)})`, params: keys as SqlValue[] }];
    if (query.owned === true) return clauses;
    let spaces = [...new Set(grants.map((grant) => grant.space))];
    if (query.space !== undefined) spaces = spaces.filter((space) => space === query.space);
    const size = Math.max(1, Math.min(CHUNK_MAX, room));
    for (let at = 0; at < spaces.length; at += size) {
      const chunk = spaces.slice(at, at + size);
      clauses.push({ clause: `e.space IN (${marks(chunk.length)})`, params: chunk });
    }
    return clauses;
  };

  /** Applies `updates`, in one transaction. */
  const record = async (updates: readonly Update[]): Promise<void> => {
    if (updates.length === 0) return;
    const database = await db();
    await database.transaction(async (tx) => {
      for (const update of updates) await apply(tx, update);
    });
  };

  return {
    seen: record,

    async list(viewer, query, grants) {
      const database = await db();
      if (query.cursor !== undefined) parseDirectoryCursor(query.cursor);
      const { act, from, columns, where, params } = listing(viewer, query);
      const select = (extra?: { clause: string; params: SqlValue[] }) =>
        database.query<Row>(
          `SELECT e.*, ${columns} FROM ${from} WHERE ${[...where, ...(extra === undefined ? [] : [extra.clause])].join(" AND ")} ` +
            `ORDER BY ${act} DESC, e.key DESC, e.conversation DESC LIMIT ?`,
          [...params, ...(extra?.params ?? []), query.limit + 1],
        );
      const rows = viewer.kind === "people" ? (await Promise.all(visibility(viewer, query, grants, PARAMS_MAX - params.length - 1).map(select))).flat() : await select();
      const found: { row: Row; role: DirectoryRole }[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const id = JSON.stringify([row.key, row.conversation]);
        if (seen.has(id)) continue;
        seen.add(id);
        const role = roleOn(viewer, row, grants);
        if (role !== undefined && role !== "needs") found.push({ row, role });
      }
      const position = ({ row }: { row: Row }) => ({ lastActivity: activityFor(viewer, row), key: row.key, conversationId: row.conversation });
      const after = query.cursor === undefined ? undefined : parseDirectoryCursor(query.cursor);
      const ordered = found.filter((each) => after === undefined || afterCursor(position(each), after)).sort((a, b) => compareDirectoryOrder(position(a), position(b)));
      const page = ordered.slice(0, query.limit);
      const items = await Promise.all(page.map(({ row, role }) => entryOf(database, viewer, row, role)));
      const last = page.at(-1);
      return { items, ...(ordered.length > page.length && last !== undefined && { next: directoryCursor(position(last)) }) };
    },

    async count(viewer, spaces, grants) {
      const database = await db();
      const counts: Record<string, number> = {};
      for (const space of spaces) {
        const { from, where, params } = listing(viewer, { limit: 1, state: "listed", space });
        const extra: { clause: string; params: SqlValue[] }[] = [];
        if (viewer.kind === "people" && grantRole(grants, space) === undefined) {
          const keys = viewer.principals.map(principalKey);
          extra.push({ clause: `e.owner IN (${marks(keys.length)})`, params: keys });
        }
        const [row] = await database.query<{ n: number }>(`SELECT count(*) AS n FROM ${from} WHERE ${[...where, ...extra.map((each) => each.clause)].join(" AND ")}`, [
          ...params,
          ...extra.flatMap((each) => each.params),
        ]);
        counts[space] = Number(row?.n ?? 0);
      }
      return counts;
    },

    async access(viewer, ref, grants) {
      const database = await db();
      const seen = await access(database, viewer, ref, grants);
      if (seen === undefined) return {};
      if ("needs" in seen) return { needs: seen.needs };
      return { entry: await entryOf(database, viewer, seen.row, seen.role) };
    },

    async rename(viewer, ref, title, grants) {
      const database = await db();
      const seen = await seenOr404(database, viewer, ref, grants);
      if ("needs" in seen) return { needs: seen.needs };
      if (!permissionsOf(seen.role).rename) return bad("forbidden", "only the conversation's owner, its space's owner, an operator or trusted code renames it for everyone");
      const cleaned = cleanTitle(title);
      if (cleaned === undefined) return bad("invalid", "a title has words");
      await titled(database, ref, { text: cleaned, source: "rename", at: now() });
      const row = (await rowOf(database, viewer, ref)) as Row;
      return { entry: await entryOf(database, viewer, row, seen.role) };
    },

    async setState(viewer, ref, next, grants, ctx) {
      const database = await db();
      const seen = await seenOr404(database, viewer, ref, grants);
      if ("needs" in seen) return { needs: seen.needs };
      const { row, role } = seen;
      const may = permissionsOf(role);
      if (!(next === "deleted" || row.state === "deleted" ? may.delete : may.archive)) return bad("forbidden", "not this viewer's to change for everyone");
      if (row.state === next) return { entry: await entryOf(database, viewer, row, role) };
      // Deleting a key's current conversation resets the key first, in its own App: a failure changes nothing.
      if (next === "deleted" && Number(row.is_current) === 1) await record(await options.reset(row.key, row.conversation, ctx));
      await database.run(`UPDATE ${ENTRIES} SET state = ?, state_at = ?, state_by = ? WHERE key = ? AND conversation = ?`, [
        next,
        now(),
        JSON.stringify(viewerAuthor(viewer)),
        row.key,
        row.conversation,
      ]);
      return { entry: await entryOf(database, viewer, (await rowOf(database, viewer, ref)) as Row, role) };
    },

    async mine(viewer, ref, change, grants) {
      const own = viewerKey(viewer);
      if (own === undefined) return bad("invalid", "a component has no state of its own");
      const { hidden, readUpTo, name } = (change ?? {}) as ViewerChange;
      if (hidden !== undefined && typeof hidden !== "boolean") return bad("invalid", "hidden is a boolean");
      if (readUpTo !== undefined && (typeof readUpTo !== "number" || !Number.isSafeInteger(readUpTo) || readUpTo < 0)) return bad("invalid", "readUpTo is a time");
      const cleaned = typeof name === "string" ? cleanTitle(name) : undefined;
      if (name !== undefined && name !== null && cleaned === undefined) return bad("invalid", "a name has words");
      const database = await db();
      const seen = await seenOr404(database, viewer, ref, grants);
      if ("needs" in seen) return { needs: seen.needs };
      const { row, role } = seen;
      const at = now();
      let hiddenAt = row.hidden_at === null ? null : Number(row.hidden_at);
      if (hidden === true) hiddenAt = at;
      if (hidden === false) hiddenAt = null;
      const readAt = readUpTo === undefined ? row.read_at : Math.max(Number(row.read_at ?? 0), Math.min(readUpTo, at));
      const named = name === null ? null : (cleaned ?? row.name);
      await database.run(
        `INSERT INTO ${VIEWERS} (viewer, key, conversation, hidden_at, read_at, name, name_search) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT (viewer, key, conversation) DO UPDATE SET hidden_at = excluded.hidden_at, read_at = excluded.read_at, name = excluded.name, name_search = excluded.name_search",
        [own, ref.key, ref.conversationId, hiddenAt, readAt, named, named === null ? null : named.toLowerCase()],
      );
      return { entry: await entryOf(database, viewer, (await rowOf(database, viewer, ref)) as Row, role) };
    },

    async title(ref, title) {
      const database = await db();
      await database.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${ENTRIES} (key, conversation) VALUES (?, ?) ON CONFLICT (key, conversation) DO NOTHING`, [ref.key, ref.conversationId]);
        await titled(tx, ref, { text: title.text, source: title.source, at: now() });
      });
    },
  };
}
