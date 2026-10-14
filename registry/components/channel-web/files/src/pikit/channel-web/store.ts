/**
 * The channel's own store, in `storage.sql` (tables prefixed `channel_web_`): what the users see of
 * their conversations. It is the channel's platform: answers are delivered into it.
 *
 * - **`channel_web_conversations`**: one row per conversation (its key, user, chat id, title, when it
 *   was made, its newest activity, whether the user deleted it from the list, whether a run goes, and a
 *   version). On a server it is the App's own table, and the list reads it. On Cloudflare each
 *   conversation's object holds its own row, the truth, and tells the users' index (the same table in
 *   the accounts actor, `channel-web:accounts`) each new version (`seen`): an upsert that a late or
 *   repeated version changes nothing with.
 * - **`channel_web_messages`**: the user's messages, written once admitted (with their images, state
 *   `pending`), and each answer, written by the delivery transport under its idempotency key (written
 *   twice, stored once). A message's images' types are a column of their own (`image_types`): a page
 *   of messages never reads their bytes, which only `image` does, one image at a time. A page holds at
 *   most `PAGE_TEXT_MAX` characters of text (at least one message): past it, it ends early, its cursor
 *   where the next starts. A user message's state moves from `pending` to `answered`, `failed` or
 *   `aborted` when its run ends. On Cloudflare, in the conversation's object.
 *
 * Who follows a conversation live (`live.ts`) hears of each message stored or changed (`notify`), in
 * this process: the store is written where the conversation's live view is made.
 */

import { ActorCallError, type SqlDatabase } from "@pikit/contracts";
import { type ChatImage, type ChatMessage, PAGE_TEXT_MAX } from "./api.ts";

const CONVERSATIONS = "channel_web_conversations";
const MESSAGES = "channel_web_messages";

/** One conversation as the channel keeps it. JSON: it crosses an actor (`seen`). */
export type ConversationRow = {
  key: string;
  userId: string;
  chatId: string;
  title: string;
  createdAt: number;
  /** Epoch ms of its newest message. */
  lastActivity: number;
  /** The user deleted it from their list: it is gone for them (every route `404`), kept in the runtime. */
  hidden: boolean;
  /** Whether a run goes, as last told (a single conversation's read asks the runtime). */
  busy: boolean;
  /** Bumped by every change: the index keeps the newest. */
  version: number;
};

/**
 * A message as stored: its images with their bytes when written (`add`), their types only when read
 * (`messages`: `imageTypes`); and the runtime conversation a user's message went to (to ask
 * `agent.submissions` about it).
 */
export type StoredMessage = Omit<ChatMessage, "images"> & { images?: ChatImage[]; imageTypes?: string[]; conversation?: string };

export type MessageState = NonNullable<ChatMessage["state"]>;

/**
 * What a follower hears: a message stored, or a user's message whose state changed. `answer`: it is an
 * answer the transport stored (its id the piece's key, `answerKey(...)#<index>`).
 */
export type StoreNote = { type: "message"; id: string; answer?: true };

export type Paged<T> = { items: T[]; next?: string };

export interface ChatStore {
  conversation(key: string): Promise<ConversationRow | undefined>;
  /** Makes the conversation's row unless it has one; the row stored. */
  create(row: Omit<ConversationRow, "version" | "hidden">): Promise<ConversationRow>;
  /** Changes the row (a newer activity only moves it forward) and bumps its version; `undefined` when there is none. */
  change(key: string, change: { title?: string; hidden?: boolean; busy?: boolean; activity?: number }): Promise<ConversationRow | undefined>;

  /** The index's: keeps each row unless it holds a newer version of it. */
  seen(rows: readonly ConversationRow[]): Promise<void>;
  /** The index's: `userId`'s conversations not deleted, newest activity first. Throws `invalid_cursor`. */
  list(userId: string, page: { limit: number; cursor?: string }): Promise<Paged<ConversationRow>>;
  /** The index's: `userId`'s conversations leave it (the user was removed). */
  forget(userId: string): Promise<void>;

  /** Stores `message` in `key` unless it has a message of its id: whether it did. */
  add(key: string, message: StoredMessage): Promise<boolean>;
  /** Newest first, their images' types only (`imageTypes`), at most `PAGE_TEXT_MAX` of text. Throws `invalid_cursor`. */
  messages(key: string, page: { limit: number; cursor?: string }): Promise<Paged<StoredMessage>>;
  /** Image `index` of the user's message `id` in `key`, or `undefined`. */
  image(key: string, id: string, index: number): Promise<ChatImage | undefined>;
  /** Moves the user's messages `ids` still `pending` to `state`: the ids it moved. */
  settle(key: string, ids: readonly string[], state: MessageState): Promise<string[]>;

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

/** `<number>:<text>` of a page's last item; the text URI-encoded. */
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

type ConversationSqlRow = {
  key: string;
  user_id: string;
  chat_id: string;
  title: string;
  created_at: number;
  last_activity: number;
  hidden: number;
  busy: number;
  version: number;
};
type MessageSqlRow = { id: string; role: string; text: string; image_types: string | null; at: number; state: string | null; conversation: string | null };

const rowOf = (row: ConversationSqlRow): ConversationRow => ({
  key: row.key,
  userId: row.user_id,
  chatId: row.chat_id,
  title: row.title,
  createdAt: Number(row.created_at),
  lastActivity: Number(row.last_activity),
  hidden: Number(row.hidden) === 1,
  busy: Number(row.busy) === 1,
  version: Number(row.version),
});

const messageOf = (row: MessageSqlRow): StoredMessage => ({
  id: row.id,
  role: row.role === "assistant" ? "assistant" : "user",
  text: row.text,
  ...(row.image_types !== null && { imageTypes: JSON.parse(row.image_types) as string[] }),
  at: Number(row.at),
  ...(row.state !== null && { state: row.state as MessageState }),
  ...(row.conversation !== null && { conversation: row.conversation }),
});

const COLUMNS = "key, user_id, chat_id, title, created_at, last_activity, hidden, busy, version";

/** The store over `sql()` (`storage.sql`); its tables are made at the first use. */
export function createChatStore(sql: () => SqlDatabase): ChatStore {
  let ready: Promise<void> | undefined;
  const db = async (): Promise<SqlDatabase> => {
    const database = sql();
    ready ??= (async () => {
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${CONVERSATIONS} (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL, ` +
          "created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL, hidden INTEGER NOT NULL, busy INTEGER NOT NULL, version BIGINT NOT NULL)",
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${CONVERSATIONS}_user ON ${CONVERSATIONS} (user_id, last_activity, chat_id)`);
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${MESSAGES} (key TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, images TEXT, image_types TEXT, ` +
          "at BIGINT NOT NULL, state TEXT, conversation TEXT, PRIMARY KEY (key, id))",
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${MESSAGES}_at ON ${MESSAGES} (key, at, id)`);
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
    const [row] = await (await db()).query<ConversationSqlRow>(`SELECT ${COLUMNS} FROM ${CONVERSATIONS} WHERE key = ?`, [key]);
    return row === undefined ? undefined : rowOf(row);
  };

  return {
    conversation,

    async create(row) {
      await (await db()).run(
        `INSERT INTO ${CONVERSATIONS} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1) ON CONFLICT (key) DO NOTHING`,
        [row.key, row.userId, row.chatId, row.title, Math.floor(row.createdAt), Math.floor(row.lastActivity), row.busy ? 1 : 0],
      );
      return (await conversation(row.key)) as ConversationRow;
    },

    async change(key, change) {
      const database = await db();
      const changed = await database.transaction(async (tx) => {
        const { changes } = await tx.run(
          `UPDATE ${CONVERSATIONS} SET title = COALESCE(?, title), hidden = COALESCE(?, hidden), busy = COALESCE(?, busy), ` +
            "last_activity = CASE WHEN ? > last_activity THEN ? ELSE last_activity END, version = version + 1 WHERE key = ?",
          [
            change.title ?? null,
            change.hidden === undefined ? null : change.hidden ? 1 : 0,
            change.busy === undefined ? null : change.busy ? 1 : 0,
            Math.floor(change.activity ?? 0),
            Math.floor(change.activity ?? 0),
            key,
          ],
        );
        if (changes === 0) return undefined;
        const [row] = await tx.query<ConversationSqlRow>(`SELECT ${COLUMNS} FROM ${CONVERSATIONS} WHERE key = ?`, [key]);
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
            `INSERT INTO ${CONVERSATIONS} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET ` +
              "title = excluded.title, last_activity = excluded.last_activity, hidden = excluded.hidden, busy = excluded.busy, version = excluded.version " +
              `WHERE excluded.version > ${CONVERSATIONS}.version`,
            [row.key, row.userId, row.chatId, row.title, Math.floor(row.createdAt), Math.floor(row.lastActivity), row.hidden ? 1 : 0, row.busy ? 1 : 0, Math.floor(row.version)],
          );
        }
      });
    },

    async list(userId, { limit, cursor }) {
      const after = cursor === undefined ? undefined : parseCursor(cursor);
      const rows = await (await db()).query<ConversationSqlRow>(
        `SELECT ${COLUMNS} FROM ${CONVERSATIONS} WHERE user_id = ? AND hidden = 0` +
          (after === undefined ? "" : " AND (last_activity < ? OR (last_activity = ? AND chat_id > ?))") +
          " ORDER BY last_activity DESC, chat_id ASC LIMIT ?",
        after === undefined ? [userId, limit + 1] : [userId, after.at, after.at, after.id, limit + 1],
      );
      const items = rows.slice(0, limit).map(rowOf);
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: cursorOf(last.lastActivity, last.chatId) }) };
    },

    async forget(userId) {
      await (await db()).run(`DELETE FROM ${CONVERSATIONS} WHERE user_id = ?`, [userId]);
    },

    async add(key, message) {
      const { changes } = await (await db()).run(
        `INSERT INTO ${MESSAGES} (key, id, role, text, images, image_types, at, state, conversation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key, id) DO NOTHING`,
        [
          key,
          message.id,
          message.role,
          message.text,
          message.images === undefined || message.images.length === 0 ? null : JSON.stringify(message.images),
          message.images === undefined || message.images.length === 0 ? null : JSON.stringify(message.images.map((image) => image.mimeType)),
          Math.floor(message.at),
          message.state ?? null,
          message.conversation ?? null,
        ],
      );
      return changes > 0;
    },

    async messages(key, { limit, cursor }) {
      const after = cursor === undefined ? undefined : parseCursor(cursor);
      const rows = await (await db()).query<MessageSqlRow>(
        `SELECT id, role, text, image_types, at, state, conversation FROM ${MESSAGES} WHERE key = ?` +
          (after === undefined ? "" : " AND (at < ? OR (at = ? AND id < ?))") +
          " ORDER BY at DESC, id DESC LIMIT ?",
        after === undefined ? [key, limit + 1] : [key, after.at, after.at, after.id, limit + 1],
      );
      // At most PAGE_TEXT_MAX of text, but always one message: a page that ends early has a cursor.
      let text = 0;
      let kept = 0;
      for (const row of rows.slice(0, limit)) {
        text += row.text.length;
        if (kept > 0 && text > PAGE_TEXT_MAX) break;
        kept++;
      }
      const items = rows.slice(0, kept).map(messageOf);
      const last = items.at(-1);
      return { items, ...(rows.length > kept && last !== undefined && { next: cursorOf(last.at, last.id) }) };
    },

    async image(key, id, index) {
      const [row] = await (await db()).query<{ images: string | null }>(`SELECT images FROM ${MESSAGES} WHERE key = ? AND id = ? AND role = 'user'`, [key, id]);
      if (row?.images === null || row?.images === undefined) return undefined;
      return (JSON.parse(row.images) as ChatImage[])[index];
    },

    async settle(key, ids, state) {
      const database = await db();
      const moved: string[] = [];
      for (const id of ids) {
        const { changes } = await database.run(`UPDATE ${MESSAGES} SET state = ? WHERE key = ? AND id = ? AND role = 'user' AND state = 'pending'`, [state, key, id]);
        if (changes > 0) moved.push(id);
      }
      return moved;
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
