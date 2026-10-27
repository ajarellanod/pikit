/**
 * The channel's own store, in `storage.sql` (tables prefixed `channel_web_`): what the users see of
 * their conversations. It is the channel's platform: what a run wrote is stored into it.
 *
 * - **`channel_web_conversations`**: one row per conversation (its key, user, chat id, the agent it was
 *   made with, the project it was made in (`""`: none), title (and the title lowercased, for a search), when it was made, its newest activity,
 *   whether the user deleted it from the list, whether they archived it (listed apart until new
 *   activity comes), whether a run goes, and a version). On a server it is the App's own table, and the
 *   list reads it. On Cloudflare each conversation's object holds its own row, the truth, and tells the
 *   users' index (the same table in the accounts actor, `channel-web:accounts`) each new version
 *   (`seen`): an upsert that a late or repeated version changes nothing with.
 * - **`channel_web_entries`**: the conversation's transcript, one row per entry (`entries.ts` makes
 *   them `ChatTranscriptEntry`s):
 *   - `user`: a user's message, written once admitted (its images with it, state `pending`); its state
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
 *   On Cloudflare, in the conversation's object.
 *
 * - **`channel_web_projects`**: each user's projects (id, name, when made), beside the users' index (on
 *   Cloudflare in the accounts actor): a project with conversations not deleted is not deleted.
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

const CONVERSATIONS = "channel_web_conversations";
const ENTRIES = "channel_web_entries";
const PROJECTS = "channel_web_projects";
const COMMANDS = "channel_web_commands";

/** One conversation as the channel keeps it. JSON: it crosses an actor (`seen`). */
export type ConversationRow = {
  key: string;
  userId: string;
  chatId: string;
  /** The agent it was made with (`ConversationRef.agent`). */
  agent: string;
  /** The user's project it was made in (`ChatProject.id`), for good; `""`: none. */
  project: string;
  title: string;
  createdAt: number;
  /** Epoch ms of its newest message. */
  lastActivity: number;
  /** The user deleted it from their list: it is gone for them (every route `404`), kept in the runtime. */
  hidden: boolean;
  /** The user archived it: listed apart (`list`'s `archived`), still theirs; newer activity lists it again. */
  archived: boolean;
  /** Whether a run goes, as last told (a single conversation's read asks the runtime). */
  busy: boolean;
  /** Bumped by every change: the index keeps the newest. */
  version: number;
};

export type MessageState = NonNullable<ChatTranscriptEntry["state"]>;

/** A user's message to store: its images with their bytes, the runtime conversation it went to (to ask `agent.submissions`), whether it is `held`. */
export type NewUserRow = { id: string; text: string; images?: ChatImage[]; at: number; state: MessageState; conversation: string; held: boolean };

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

/**
 * A page of the list: not archived, or with `archived` the archived ones; with `q`, only titles holding
 * it; with `project`, only that project's (`""`: those of no project, or of a project that is no more).
 */
export type ListQuery = { limit: number; cursor?: string; archived?: boolean; q?: string; project?: string };

/** One of a user's projects, and how many of their conversations (not deleted) are in it. */
export type ProjectRow = { userId: string; id: string; name: string; createdAt: number; chats: number };

/** What came of a command typed in a conversation (`ChatCommandResult`), as kept by its request id. */
export type CommandRow = { name: string; outcome: "ran" | "failed" | "unfinished"; text?: string };

export interface ChatStore {
  conversation(key: string): Promise<ConversationRow | undefined>;
  /** Makes the conversation's row unless it has one; the row stored. */
  create(row: Omit<ConversationRow, "version" | "hidden" | "archived">): Promise<ConversationRow>;
  /**
   * Changes the row (a newer activity only moves it forward, and takes it out of the archived ones unless
   * `archived` is given) and bumps its version; `undefined` when there is none, or with `whenTitle` when
   * its title is not that one now (a model's title never replaces one the user gave meanwhile).
   */
  change(key: string, change: { title?: string; hidden?: boolean; archived?: boolean; busy?: boolean; activity?: number; whenTitle?: string }): Promise<ConversationRow | undefined>;

  /** The index's: keeps each row unless it holds a newer version of it. */
  seen(rows: readonly ConversationRow[]): Promise<void>;
  /** The index's: `userId`'s conversations not deleted, newest activity first. Throws `invalid_cursor`. */
  list(userId: string, query: ListQuery): Promise<Paged<ConversationRow>>;
  /** The index's: `userId`'s conversations and projects leave it (the user was removed). */
  forget(userId: string): Promise<void>;

  /** The index's: `userId`'s projects, by name. */
  projects(userId: string): Promise<ProjectRow[]>;
  /** The index's: `userId`'s project `id`, or `undefined` (none, or another user's). */
  project(userId: string, id: string): Promise<ProjectRow | undefined>;
  /** The index's: a new project of `userId`'s, unless they have `max` already (`false`). */
  createProject(row: Omit<ProjectRow, "chats">, max: number): Promise<boolean>;
  /** The index's: whether `userId` has the project `id`, renamed. */
  renameProject(userId: string, id: string, name: string): Promise<boolean>;
  /** The index's: `userId`'s project `id` deleted, unless a conversation (not deleted) is in it. */
  deleteProject(userId: string, id: string): Promise<"deleted" | "not_found" | "not_empty">;

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
  /** The text of the first user's message stored in `key` (`""` with images only), or `undefined` before one is. */
  firstText(key: string): Promise<string | undefined>;
  /** Image `index` of the user's message `id` in `key`, or `undefined`. */
  image(key: string, id: string, index: number): Promise<ChatImage | undefined>;
  /** Moves the user's messages `ids` still `pending` to `state`: the ids it moved. */
  settle(key: string, ids: readonly string[], state: MessageState): Promise<string[]>;
  /** Puts every held message of `key` in the transcript: those it released. */
  release(key: string): Promise<UserRow[]>;

  /** Hears what is stored in `key` from now on, until the returned function is called. */
  subscribe(key: string, listener: (note: StoreNote) => void): () => void;
  notify(key: string, note: StoreNote): void;

  /**
   * The request that started the run going in runtime conversation `conversationId` (`agent.started`),
   * until it ends: in memory, in the App that runs it (a server, or the conversation's object), where
   * the live view is made. A view opened mid-run names the run by it (a snapshot names its inputs by
   * submission id only). Lost with the process, and so is the run's watch: nothing stale outlives it.
   */
  runStarted(conversationId: string, requestId: string): void;
  runEnded(conversationId: string): void;
  startedBy(conversationId: string): string | undefined;
}

const invalidCursor = (): ActorCallError => new ActorCallError("invalid_cursor", "the cursor is not one this API gave");

/** `<number>:<text>` of a list page's last row; the text URI-encoded. */
function parseCursor(cursor: string): { at: number; id: string } {
  const at = cursor.indexOf(":");
  const number = cursor.slice(0, at);
  if (at <= 0 || !/^[0-9]+$/.test(number)) throw invalidCursor();
  try {
    return { at: Number(number), id: decodeURIComponent(cursor.slice(at + 1)) };
  } catch {
    throw invalidCursor();
  }
}
const cursorOf = (at: number, id: string): string => `${at}:${encodeURIComponent(id)}`;

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

type ConversationSqlRow = {
  key: string;
  user_id: string;
  chat_id: string;
  agent: string;
  project: string;
  title: string;
  created_at: number;
  last_activity: number;
  hidden: number;
  archived: number;
  busy: number;
  version: number;
};
type EntrySqlRow = {
  id: string;
  kind: string;
  turn: number;
  pos: number;
  run: string | null;
  text: string | null;
  image_types: string | null;
  message: string | null;
  at: number;
  state: string | null;
  conversation: string | null;
  size: number;
};

type ProjectSqlRow = { user_id: string; id: string; name: string; created_at: number; chats: number };
/** A project and its conversations not deleted; its parameters: the user's id twice. */
const PROJECT_SELECT =
  `SELECT p.user_id, p.id, p.name, p.created_at, (SELECT COUNT(*) FROM ${CONVERSATIONS} c WHERE c.user_id = ? AND c.project = p.id AND c.hidden = 0) AS chats FROM ${PROJECTS} p`;
const projectOf = (row: ProjectSqlRow): ProjectRow => ({ userId: row.user_id, id: row.id, name: row.name, createdAt: Number(row.created_at), chats: Number(row.chats) });

const rowOf = (row: ConversationSqlRow): ConversationRow => ({
  key: row.key,
  userId: row.user_id,
  chatId: row.chat_id,
  agent: row.agent,
  project: row.project,
  title: row.title,
  createdAt: Number(row.created_at),
  lastActivity: Number(row.last_activity),
  hidden: Number(row.hidden) === 1,
  archived: Number(row.archived) === 1,
  busy: Number(row.busy) === 1,
  version: Number(row.version),
});

const userOf = (row: Pick<EntrySqlRow, "id" | "text" | "image_types" | "at" | "state">): UserRow => ({
  id: row.id,
  text: row.text ?? "",
  ...(row.image_types !== null && { imageTypes: JSON.parse(row.image_types) as string[] }),
  at: Number(row.at),
  ...(row.state !== null && { state: row.state as MessageState }),
});

const entryOf = (row: EntrySqlRow): EntryRow =>
  row.kind === "user"
    ? { kind: "user", ...userOf(row), ...(row.conversation !== null && { conversation: row.conversation }) }
    : { kind: row.kind === "answer" ? "answer" : "run", id: row.id, run: row.run ?? "", message: JSON.parse(row.message ?? "null") as unknown, at: Number(row.at) };

const COLUMNS = "key, user_id, chat_id, agent, project, title, title_search, created_at, last_activity, hidden, archived, busy, version";
const SELECTED = "key, user_id, chat_id, agent, project, title, created_at, last_activity, hidden, archived, busy, version";
const ENTRY_COLUMNS = "id, kind, turn, pos, run, text, image_types, message, at, state, conversation, size";
/** A title as a search reads it: lowercased here (SQLite's `lower` knows ASCII only). */
const searchOf = (title: string): string => title.toLowerCase();
/** `q` as `LIKE` reads it: lowercased, its wildcards escaped. */
const likeOf = (q: string): string => `%${searchOf(q).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** The store over `sql()` (`storage.sql`); its tables are made at the first use. */
export function createChatStore(sql: () => SqlDatabase): ChatStore {
  let ready: Promise<void> | undefined;
  const db = async (): Promise<SqlDatabase> => {
    const database = sql();
    ready ??= (async () => {
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${CONVERSATIONS} (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, agent TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, ` +
          "title_search TEXT NOT NULL, created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL, hidden INTEGER NOT NULL, archived INTEGER NOT NULL, busy INTEGER NOT NULL, version BIGINT NOT NULL)",
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${CONVERSATIONS}_user ON ${CONVERSATIONS} (user_id, last_activity, chat_id)`);
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${ENTRIES} (key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, turn BIGINT NOT NULL, pos INTEGER NOT NULL, run TEXT, ` +
          "text TEXT, images TEXT, image_types TEXT, message TEXT, at BIGINT NOT NULL, state TEXT, conversation TEXT, held INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (key, id))",
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${ENTRIES}_order ON ${ENTRIES} (key, turn, pos, id)`);
      await database.run(`CREATE INDEX IF NOT EXISTS ${ENTRIES}_run ON ${ENTRIES} (key, run)`);
      await database.run(`CREATE TABLE IF NOT EXISTS ${PROJECTS} (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, id))`);
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${COMMANDS} (key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, outcome TEXT NOT NULL, text TEXT, at BIGINT NOT NULL, PRIMARY KEY (key, id))`,
      );
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

  const conversation = async (key: string): Promise<ConversationRow | undefined> => {
    const [row] = await (await db()).query<ConversationSqlRow>(`SELECT ${SELECTED} FROM ${CONVERSATIONS} WHERE key = ?`, [key]);
    return row === undefined ? undefined : rowOf(row);
  };

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
    conversation,

    async create(row) {
      await (await db()).run(
        `INSERT INTO ${CONVERSATIONS} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1) ON CONFLICT (key) DO NOTHING`,
        [row.key, row.userId, row.chatId, row.agent, row.project, row.title, searchOf(row.title), Math.floor(row.createdAt), Math.floor(row.lastActivity), row.busy ? 1 : 0],
      );
      return (await conversation(row.key)) as ConversationRow;
    },

    async change(key, change) {
      const database = await db();
      const changed = await database.transaction(async (tx) => {
        const { changes } = await tx.run(
          `UPDATE ${CONVERSATIONS} SET title = COALESCE(?, title), title_search = COALESCE(?, title_search), hidden = COALESCE(?, hidden), busy = COALESCE(?, busy), ` +
            // Every right-hand side reads the row as it was: newer activity unarchives it.
            "archived = COALESCE(?, CASE WHEN ? > last_activity THEN 0 ELSE archived END), " +
            "last_activity = CASE WHEN ? > last_activity THEN ? ELSE last_activity END, version = version + 1 WHERE key = ? AND (? IS NULL OR title = ?)",
          [
            change.title ?? null,
            change.title === undefined ? null : searchOf(change.title),
            change.hidden === undefined ? null : change.hidden ? 1 : 0,
            change.busy === undefined ? null : change.busy ? 1 : 0,
            change.archived === undefined ? null : change.archived ? 1 : 0,
            Math.floor(change.activity ?? 0),
            Math.floor(change.activity ?? 0),
            Math.floor(change.activity ?? 0),
            key,
            change.whenTitle ?? null,
            change.whenTitle ?? null,
          ],
        );
        if (changes === 0) return undefined;
        const [row] = await tx.query<ConversationSqlRow>(`SELECT ${SELECTED} FROM ${CONVERSATIONS} WHERE key = ?`, [key]);
        return row;
      });
      return changed === undefined ? undefined : rowOf(changed);
    },

    async seen(rows) {
      if (rows.length === 0) return;
      const database = await db();
      await database.transaction(async (tx) => {
        for (const row of rows) {
          await tx.run(
            `INSERT INTO ${CONVERSATIONS} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET ` +
              "title = excluded.title, title_search = excluded.title_search, last_activity = excluded.last_activity, hidden = excluded.hidden, archived = excluded.archived, " +
              `busy = excluded.busy, version = excluded.version WHERE excluded.version > ${CONVERSATIONS}.version`,
            [
              row.key,
              row.userId,
              row.chatId,
              row.agent,
              row.project,
              row.title,
              searchOf(row.title),
              Math.floor(row.createdAt),
              Math.floor(row.lastActivity),
              row.hidden ? 1 : 0,
              row.archived ? 1 : 0,
              row.busy ? 1 : 0,
              Math.floor(row.version),
            ],
          );
        }
      });
    },

    async list(userId, { limit, cursor, archived = false, q, project }) {
      const after = cursor === undefined ? undefined : parseCursor(cursor);
      const search = q === undefined || q.trim() === "" ? undefined : likeOf(q.trim());
      // No project: none, or one deleted while a conversation was being made in it (it lists with none).
      const inProject =
        project === undefined ? "" : project === "" ? ` AND (project = '' OR project NOT IN (SELECT id FROM ${PROJECTS} WHERE user_id = ?))` : " AND project = ?";
      const rows = await (await db()).query<ConversationSqlRow>(
        `SELECT ${SELECTED} FROM ${CONVERSATIONS} WHERE user_id = ? AND hidden = 0 AND archived = ?` +
          inProject +
          (search === undefined ? "" : " AND title_search LIKE ? ESCAPE '\\'") +
          (after === undefined ? "" : " AND (last_activity < ? OR (last_activity = ? AND chat_id > ?))") +
          " ORDER BY last_activity DESC, chat_id ASC LIMIT ?",
        [
          userId,
          archived ? 1 : 0,
          ...(project === undefined ? [] : project === "" ? [userId] : [project]),
          ...(search === undefined ? [] : [search]),
          ...(after === undefined ? [] : [after.at, after.at, after.id]),
          limit + 1,
        ],
      );
      const items = rows.slice(0, limit).map(rowOf);
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: cursorOf(last.lastActivity, last.chatId) }) };
    },

    async forget(userId) {
      const database = await db();
      await database.run(`DELETE FROM ${CONVERSATIONS} WHERE user_id = ?`, [userId]);
      await database.run(`DELETE FROM ${PROJECTS} WHERE user_id = ?`, [userId]);
    },

    async projects(userId) {
      const rows = await (await db()).query<ProjectSqlRow>(`${PROJECT_SELECT} WHERE p.user_id = ? ORDER BY p.name, p.id`, [userId, userId]);
      return rows.map(projectOf);
    },

    async project(userId, id) {
      const [row] = await (await db()).query<ProjectSqlRow>(`${PROJECT_SELECT} WHERE p.user_id = ? AND p.id = ?`, [userId, userId, id]);
      return row === undefined ? undefined : projectOf(row);
    },

    async createProject(row, max) {
      // One statement: two at once never make more than `max`.
      const { changes } = await (await db()).run(
        `INSERT INTO ${PROJECTS} (user_id, id, name, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ${PROJECTS} WHERE user_id = ?) < ?`,
        [row.userId, row.id, row.name, Math.floor(row.createdAt), row.userId, max],
      );
      return changes > 0;
    },

    async renameProject(userId, id, name) {
      const { changes } = await (await db()).run(`UPDATE ${PROJECTS} SET name = ? WHERE user_id = ? AND id = ?`, [name, userId, id]);
      return changes > 0;
    },

    async deleteProject(userId, id) {
      const database = await db();
      const { changes } = await database.run(
        `DELETE FROM ${PROJECTS} WHERE user_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM ${CONVERSATIONS} WHERE user_id = ? AND project = ? AND hidden = 0)`,
        [userId, id, userId, id],
      );
      if (changes > 0) return "deleted";
      const [found] = await database.query<{ id: string }>(`SELECT id FROM ${PROJECTS} WHERE user_id = ? AND id = ?`, [userId, id]);
      return found === undefined ? "not_found" : "not_empty";
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
      // One statement: its turn the next of the key's, whatever else is written meanwhile.
      const { changes } = await (await db()).run(
        `INSERT INTO ${ENTRIES} (key, id, kind, turn, pos, run, text, images, image_types, message, at, state, conversation, held, size) ` +
          `SELECT ?, ?, 'user', COALESCE(MAX(turn), 0) + 1, 0, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ? FROM ${ENTRIES} WHERE key = ? ON CONFLICT (key, id) DO NOTHING`,
        [
          key,
          message.id,
          message.text,
          images === undefined ? null : JSON.stringify(images),
          images === undefined ? null : JSON.stringify(images.map((image) => image.mimeType)),
          Math.floor(message.at),
          message.state,
          message.conversation,
          message.held ? 1 : 0,
          message.text.length,
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

    async firstText(key) {
      const [row] = await (await db()).query<{ text: string | null }>(`SELECT text FROM ${ENTRIES} WHERE key = ? AND kind = 'user' ORDER BY turn, id LIMIT 1`, [key]);
      return row === undefined ? undefined : (row.text ?? "");
    },

    async image(key, id, index) {
      const [row] = await (await db()).query<{ images: string | null }>(`SELECT images FROM ${ENTRIES} WHERE key = ? AND id = ? AND kind = 'user'`, [key, id]);
      if (row?.images === null || row?.images === undefined) return undefined;
      return (JSON.parse(row.images) as ChatImage[])[index];
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
