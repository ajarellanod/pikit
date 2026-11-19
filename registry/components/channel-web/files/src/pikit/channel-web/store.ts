/**
 * The channel's own store, in `storage.sql` (tables prefixed `channel_web_`): the transcripts of its
 * conversations. It is the channel's platform: what a run wrote is stored into it. Which conversations
 * exist, their titles, their order and who sees them are `conversations.directory`'s
 * (`directory.ts`): nothing here lists conversations.
 *
 * - **`channel_web_entries`**: the conversation's transcript, one row per entry (`entries.ts` makes
 *   them `ChatTranscriptEntry`s):
 *   - `user`: a user's message, written once admitted (its images with it, its files' names alone, state `pending`); its state
 *     moves to `answered`, `failed` or `aborted` when its run ends (`settle`). One admitted while a run
 *     went (`queued`) is `held`: out of the transcript until a run of the conversation ends (`release`),
 *     so that it is never read before the messages of the run it waited behind, which are stored only
 *     once that run ends.
 *   - `run`: a message of a run that answered a user's message, written when the run ends (`addRun`):
 *     its id `runEntryId`, the run named by its first request (`run`).
 *   - `answer`: a run's answer as answer delivery wrote it (`addAnswer`), only for a run with no `run`
 *     row (its end not heard, a crash); deleted when its `run` rows come.
 *   Entries are in turns: a user's message opens one (`turn`, its position `0`); a run's messages are
 *   in the turn of the newest user message it answered (positions `1…`), whenever it ends. Read newest
 *   first (`turn`, `pos`, `id`). A message's images' bytes are read only by `image`, one at a time; a
 *   page of entries holds at most `PAGE_JSON_MAX` characters of stored JSON (at least one entry).
 *   On Cloudflare, in the conversation's object. A key's entries are its current runtime conversation's:
 *   they go when the key is reset ("Delete for everyone", an operator's reset: `startOver`), so a key
 *   started over never shows what its previous conversation said.
 * - **`channel_web_resets`**: the keys started over, each with the runtime conversation it was pointed
 *   to: that conversation is no chat of its user's (every route `404`) until a first message starts one
 *   in it (`started`). On Cloudflare, in the conversation's object.
 *
 * - **`channel_web_projects`**: the projects this channel kept itself before the project store
 *   (`projects`) kept them: read once by the migration (`formerProjects`; on Cloudflare in the accounts
 *   actor), each row dropped once carried over, then the table.
 * - **`channel_web_commands`**: the commands typed in a conversation, by request id (claimed before it
 *   runs, then what came of it): a request id runs a command at most once. On Cloudflare, in the
 *   conversation's object.
 *
 * Who follows a conversation live (`live.ts`) hears of each entry of the user's stored or released and
 * of anything else stored or changed (`notify`), in this process: the store is written where the
 * conversation's live view is made.
 */

import { ActorCallError, type SqlDatabase } from "@pikit/contracts";
import { type ChatImage, type ChatTranscriptEntry, PAGE_JSON_MAX } from "./api.ts";
import type { UserRow } from "./entries.ts";

const ENTRIES = "channel_web_entries";
const PROJECTS = "channel_web_projects";
const COMMANDS = "channel_web_commands";
const RESETS = "channel_web_resets";

export type MessageState = NonNullable<ChatTranscriptEntry["state"]>;

/** A user's message to store: its images with their bytes, the runtime conversation it went to (to ask `agent.submissions`), whether it is `held`. */
export type NewUserRow = { id: string; text: string; images?: ChatImage[]; fileNames?: string[]; at: number; state: MessageState; conversation: string; held: boolean };

/** An entry as read: a user's message (its images' types only), or a message a run wrote. */
export type EntryRow =
  | ({ kind: "user"; conversation?: string } & UserRow)
  | { kind: "run" | "answer"; id: string; run: string; message: unknown; at: number };

/**
 * What a follower hears: an entry of the user's now in the transcript (stored, or released), or
 * something else stored or changed (a run's messages, a message's state).
 */
export type StoreNote = { type: "entry"; entry: ChatTranscriptEntry } | { type: "changed" };

export type Paged<T> = { items: T[]; next?: string };

/** A project this channel kept itself before the project store (its former table). */
export type FormerProjectRow = { userId: string; id: string; name: string; createdAt: number };

/** What came of a command typed in a conversation (`ChatCommandResult`), as kept by its request id. */
export type CommandRow = { name: string; outcome: "ran" | "failed" | "unfinished"; text?: string };

export interface ChatStore {
  /** The former projects' rows (none once the table went). */
  formerProjects(): Promise<FormerProjectRow[]>;
  /** A former project's row, carried over. */
  dropFormerProject(userId: string, id: string): Promise<void>;
  /** The former projects' table, once every row was carried over. */
  dropFormerProjects(): Promise<void>;

  /**
   * The conversation's: the command typed as request `id` claimed, before it runs (`false`: claimed
   * already, by a run of it or one going): a request id runs a command at most once.
   */
  claimCommand(key: string, id: string, name: string, at: number): Promise<boolean>;
  /** What came of the command claimed as `id`: `unfinished` until `commandRan`; `undefined` when none was claimed. */
  command(key: string, id: string): Promise<CommandRow | undefined>;
  commandRan(key: string, id: string, result: CommandRow): Promise<void>;
  /** The claim of `id` dropped: nothing ran (it was refused, or was no command after all). */
  unclaimCommand(key: string, id: string): Promise<void>;

  /** Stores a user's message in `key`, opening a turn, unless it has one of its id: whether it did. */
  addUser(key: string, message: NewUserRow): Promise<boolean>;
  /**
   * Stores the messages of the run `run` (its first request) that took `requestIds`, in the turn of the
   * newest of them stored, each once (by id); its `answer` rows go once one is stored. How many it stored.
   */
  addRun(key: string, run: string, requestIds: readonly string[], messages: readonly { id: string; message: unknown; at: number }[]): Promise<number>;
  /** Stores the answer of the run `run` as delivery wrote it, unless the run's messages are stored: whether it did. */
  addAnswer(key: string, run: string, id: string, message: unknown, at: number): Promise<boolean>;
  /** The transcript, newest first, held messages left out, at most `PAGE_JSON_MAX` of JSON. Throws `invalid_cursor`. */
  entries(key: string, page: { limit: number; cursor?: string }): Promise<Paged<EntryRow>>;
  /** Image `index` of the user's message `id` in `key`, or `undefined`. */
  image(key: string, id: string, index: number): Promise<ChatImage | undefined>;
  /** `key` was reset to runtime conversation `conversationId`: its entries gone, and that conversation no chat until `started`. */
  startOver(key: string, conversationId: string): Promise<void>;
  /** The conversation `key` was last reset to, while no first message started a chat in it. */
  startedOver(key: string): Promise<string | undefined>;
  /** A first message started a chat in `key`: no longer one started over. */
  started(key: string): Promise<void>;
  /** Moves the user's messages `ids` still `pending` to `state`: the ids it moved. */
  settle(key: string, ids: readonly string[], state: MessageState): Promise<string[]>;
  /** Puts every held message of `key` in the transcript: those it released. */
  release(key: string): Promise<UserRow[]>;

  /** Hears what is stored in `key` from now on, until the returned function is called. */
  subscribe(key: string, listener: (note: StoreNote) => void): () => void;
  notify(key: string, note: StoreNote): void;

  /**
   * The request that started the run going in runtime conversation `conversationId` (`agent.started`),
   * until it ends: in memory, in the App that runs it (a server, or the conversation's object). A run
   * that ended before its admission returned settles its message from `agent.submissions` unless one
   * goes (`backend.ts`'s `endedEarly`). Lost with the process: nothing stale outlives it.
   */
  runStarted(conversationId: string, requestId: string): void;
  runEnded(conversationId: string): void;
  startedBy(conversationId: string): string | undefined;
}

const invalidCursor = (): ActorCallError => new ActorCallError("invalid_cursor", "the cursor is not one this API gave");

/** `<turn>.<pos>:<id>` of a transcript page's last entry. */
function parseEntryCursor(cursor: string): { turn: number; pos: number; id: string } {
  const match = /^([0-9]+)\.([0-9]+):(.*)$/s.exec(cursor);
  if (match === null) throw invalidCursor();
  try {
    return { turn: Number(match[1]), pos: Number(match[2]), id: decodeURIComponent(match[3] as string) };
  } catch {
    throw invalidCursor();
  }
}

type EntrySqlRow = {
  id: string;
  kind: string;
  turn: number;
  pos: number;
  run: string | null;
  text: string | null;
  image_types: string | null;
  file_names: string | null;
  message: string | null;
  at: number;
  state: string | null;
  conversation: string | null;
  size: number;
};

type FormerProjectSqlRow = { user_id: string; id: string; name: string; created_at: number };

const userOf = (row: Pick<EntrySqlRow, "id" | "text" | "image_types" | "file_names" | "at" | "state">): UserRow => ({
  id: row.id,
  text: row.text ?? "",
  ...(row.image_types !== null && { imageTypes: JSON.parse(row.image_types) as string[] }),
  ...(row.file_names !== null && { fileNames: JSON.parse(row.file_names) as string[] }),
  at: Number(row.at),
  ...(row.state !== null && { state: row.state as MessageState }),
});

const entryOf = (row: EntrySqlRow): EntryRow =>
  row.kind === "user"
    ? { kind: "user", ...userOf(row), ...(row.conversation !== null && { conversation: row.conversation }) }
    : { kind: row.kind === "answer" ? "answer" : "run", id: row.id, run: row.run ?? "", message: JSON.parse(row.message ?? "null") as unknown, at: Number(row.at) };

const ENTRY_COLUMNS = "id, kind, turn, pos, run, text, image_types, file_names, message, at, state, conversation, size";

/** The store over `sql()` (`storage.sql`); its tables are made at the first use. */
export function createChatStore(sql: () => SqlDatabase): ChatStore {
  let ready: Promise<void> | undefined;
  const db = async (): Promise<SqlDatabase> => {
    const database = sql();
    ready ??= (async () => {
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${ENTRIES} (key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, turn BIGINT NOT NULL, pos INTEGER NOT NULL, run TEXT, ` +
          "text TEXT, images TEXT, image_types TEXT, file_names TEXT, message TEXT, at BIGINT NOT NULL, state TEXT, conversation TEXT, held INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (key, id))",
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${ENTRIES}_order ON ${ENTRIES} (key, turn, pos, id)`);
      await database.run(`CREATE INDEX IF NOT EXISTS ${ENTRIES}_run ON ${ENTRIES} (key, run)`);
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${COMMANDS} (key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, outcome TEXT NOT NULL, text TEXT, at BIGINT NOT NULL, PRIMARY KEY (key, id))`,
      );
      await database.run(`CREATE TABLE IF NOT EXISTS ${RESETS} (key TEXT PRIMARY KEY, conversation TEXT NOT NULL)`);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return database;
  };
  const followers = new Map<string, Set<(note: StoreNote) => void>>();
  /** The request that started each runtime conversation's run going (`runStarted`). */
  const starters = new Map<string, string>();

  /** The turn of a run that took `requestIds`: the newest of them stored, else the newest turn of `key`. */
  const turnOf = async (tx: Pick<SqlDatabase, "query">, key: string, requestIds: readonly string[]): Promise<number> => {
    const ids = requestIds.slice(0, 500);
    const [answered] =
      ids.length === 0
        ? []
        : await tx.query<{ turn: number | null }>(`SELECT MAX(turn) AS turn FROM ${ENTRIES} WHERE key = ? AND kind = 'user' AND id IN (${ids.map(() => "?").join(", ")})`, [key, ...ids]);
    if (answered?.turn !== null && answered?.turn !== undefined) return Number(answered.turn);
    const [newest] = await tx.query<{ turn: number | null }>(`SELECT MAX(turn) AS turn FROM ${ENTRIES} WHERE key = ?`, [key]);
    return Number(newest?.turn ?? 0);
  };

  return {
    async formerProjects() {
      const database = await db();
      // Made here when it never was (a new App): read empty, then dropped. Dialect-neutral, no catalogue read.
      await database.run(`CREATE TABLE IF NOT EXISTS ${PROJECTS} (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, id))`);
      const rows = await database.query<FormerProjectSqlRow>(`SELECT user_id, id, name, created_at FROM ${PROJECTS} ORDER BY created_at, user_id, id`);
      return rows.map((row) => ({ userId: row.user_id, id: row.id, name: row.name, createdAt: Number(row.created_at) }));
    },

    async dropFormerProject(userId, id) {
      await (await db()).run(`DELETE FROM ${PROJECTS} WHERE user_id = ? AND id = ?`, [userId, id]);
    },

    async dropFormerProjects() {
      const database = await db();
      // Only an empty one: a row written meanwhile (an older App still running) waits for the next run.
      const [left] = await database.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PROJECTS}`);
      if (Number(left?.n ?? 0) === 0) await database.run(`DROP TABLE IF EXISTS ${PROJECTS}`);
    },

    async claimCommand(key, id, name, at) {
      const { changes } = await (await db()).run(
        `INSERT INTO ${COMMANDS} (key, id, name, outcome, text, at) VALUES (?, ?, ?, 'unfinished', NULL, ?) ON CONFLICT (key, id) DO NOTHING`,
        [key, id, name, Math.floor(at)],
      );
      return changes > 0;
    },

    async command(key, id) {
      const [row] = await (await db()).query<{ name: string; outcome: string; text: string | null }>(`SELECT name, outcome, text FROM ${COMMANDS} WHERE key = ? AND id = ?`, [key, id]);
      if (row === undefined) return undefined;
      const outcome = row.outcome === "ran" || row.outcome === "failed" ? row.outcome : "unfinished";
      return { name: row.name, outcome, ...(row.text !== null && { text: row.text }) };
    },

    async commandRan(key, id, result) {
      await (await db()).run(`UPDATE ${COMMANDS} SET name = ?, outcome = ?, text = ? WHERE key = ? AND id = ?`, [result.name, result.outcome, result.text ?? null, key, id]);
    },

    async unclaimCommand(key, id) {
      await (await db()).run(`DELETE FROM ${COMMANDS} WHERE key = ? AND id = ? AND outcome = 'unfinished'`, [key, id]);
    },

    async addUser(key, message) {
      const images = message.images === undefined || message.images.length === 0 ? undefined : message.images;
      const fileNames = message.fileNames === undefined || message.fileNames.length === 0 ? undefined : message.fileNames;
      // One statement: its turn the next of the key's, whatever else is written meanwhile.
      const { changes } = await (await db()).run(
        `INSERT INTO ${ENTRIES} (key, id, kind, turn, pos, run, text, images, image_types, file_names, message, at, state, conversation, held, size) ` +
          `SELECT ?, ?, 'user', COALESCE(MAX(turn), 0) + 1, 0, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ? FROM ${ENTRIES} WHERE key = ? ON CONFLICT (key, id) DO NOTHING`,
        [
          key,
          message.id,
          message.text,
          images === undefined ? null : JSON.stringify(images),
          images === undefined ? null : JSON.stringify(images.map((image) => image.mimeType)),
          fileNames === undefined ? null : JSON.stringify(fileNames),
          Math.floor(message.at),
          message.state,
          message.conversation,
          message.held ? 1 : 0,
          message.text.length + (fileNames === undefined ? 0 : JSON.stringify(fileNames).length),
          key,
        ],
      );
      return changes > 0;
    },

    async addRun(key, run, requestIds, messages) {
      if (messages.length === 0) return 0;
      const database = await db();
      return database.transaction(async (tx) => {
        const turn = await turnOf(tx, key, requestIds);
        let stored = 0;
        for (const [index, { id, message, at }] of messages.entries()) {
          const json = JSON.stringify(message);
          const { changes } = await tx.run(
            `INSERT INTO ${ENTRIES} (key, id, kind, turn, pos, run, message, at, held, size) VALUES (?, ?, 'run', ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (key, id) DO NOTHING`,
            [key, id, turn, index + 1, run, json, Math.floor(at), json.length],
          );
          stored += changes;
        }
        if (stored > 0) await tx.run(`DELETE FROM ${ENTRIES} WHERE key = ? AND run = ? AND kind = 'answer'`, [key, run]);
        return stored;
      });
    },

    async addAnswer(key, run, id, message, at) {
      const database = await db();
      return database.transaction(async (tx) => {
        const [found] = await tx.query<{ id: string }>(`SELECT id FROM ${ENTRIES} WHERE key = ? AND run = ? AND kind = 'run' LIMIT 1`, [key, run]);
        if (found !== undefined) return false;
        const turn = await turnOf(tx, key, [run]);
        const json = JSON.stringify(message);
        const { changes } = await tx.run(
          `INSERT INTO ${ENTRIES} (key, id, kind, turn, pos, run, message, at, held, size) VALUES (?, ?, 'answer', ?, 1, ?, ?, ?, 0, ?) ON CONFLICT (key, id) DO NOTHING`,
          [key, id, turn, run, json, Math.floor(at), json.length],
        );
        return changes > 0;
      });
    },

    async entries(key, { limit, cursor }) {
      const after = cursor === undefined ? undefined : parseEntryCursor(cursor);
      const rows = await (await db()).query<EntrySqlRow>(
        `SELECT ${ENTRY_COLUMNS} FROM ${ENTRIES} WHERE key = ? AND held = 0` +
          (after === undefined ? "" : " AND (turn < ? OR (turn = ? AND (pos < ? OR (pos = ? AND id < ?))))") +
          " ORDER BY turn DESC, pos DESC, id DESC LIMIT ?",
        after === undefined ? [key, limit + 1] : [key, after.turn, after.turn, after.pos, after.pos, after.id, limit + 1],
      );
      // At most PAGE_JSON_MAX of JSON, but always one entry: a page that ends early has a cursor.
      let size = 0;
      let kept = 0;
      for (const row of rows.slice(0, limit)) {
        size += Number(row.size);
        if (kept > 0 && size > PAGE_JSON_MAX) break;
        kept++;
      }
      const page = rows.slice(0, kept);
      const last = page.at(-1);
      return { items: page.map(entryOf), ...(rows.length > kept && last !== undefined && { next: `${Number(last.turn)}.${Number(last.pos)}:${encodeURIComponent(last.id)}` }) };
    },

    async image(key, id, index) {
      const [row] = await (await db()).query<{ images: string | null }>(`SELECT images FROM ${ENTRIES} WHERE key = ? AND id = ? AND kind = 'user'`, [key, id]);
      if (row?.images === null || row?.images === undefined) return undefined;
      return (JSON.parse(row.images) as ChatImage[])[index];
    },

    async startOver(key, conversationId) {
      const database = await db();
      await database.transaction(async (tx) => {
        await tx.run(`DELETE FROM ${ENTRIES} WHERE key = ?`, [key]);
        await tx.run(`INSERT INTO ${RESETS} (key, conversation) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET conversation = excluded.conversation`, [key, conversationId]);
      });
    },

    async startedOver(key) {
      const [row] = await (await db()).query<{ conversation: string }>(`SELECT conversation FROM ${RESETS} WHERE key = ?`, [key]);
      return row?.conversation;
    },

    async started(key) {
      await (await db()).run(`DELETE FROM ${RESETS} WHERE key = ?`, [key]);
    },

    async settle(key, ids, state) {
      const database = await db();
      const moved: string[] = [];
      for (const id of ids) {
        const { changes } = await database.run(`UPDATE ${ENTRIES} SET state = ? WHERE key = ? AND id = ? AND kind = 'user' AND state = 'pending'`, [state, key, id]);
        if (changes > 0) moved.push(id);
      }
      return moved;
    },

    async release(key) {
      const database = await db();
      return database.transaction(async (tx) => {
        const rows = await tx.query<EntrySqlRow>(`SELECT ${ENTRY_COLUMNS} FROM ${ENTRIES} WHERE key = ? AND held = 1 ORDER BY turn, id`, [key]);
        if (rows.length > 0) await tx.run(`UPDATE ${ENTRIES} SET held = 0 WHERE key = ? AND held = 1`, [key]);
        return rows.map(userOf);
      });
    },

    subscribe(key, listener) {
      const set = followers.get(key) ?? new Set();
      set.add(listener);
      followers.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && followers.get(key) === set) followers.delete(key);
      };
    },

    runStarted(conversationId, requestId) {
      starters.set(conversationId, requestId);
    },

    runEnded(conversationId) {
      starters.delete(conversationId);
    },

    startedBy: (conversationId) => starters.get(conversationId),

    notify(key, note) {
      for (const listener of followers.get(key) ?? []) {
        try {
          listener(note);
        } catch {
          // A follower's failure is its own.
        }
      }
    },
  };
}
