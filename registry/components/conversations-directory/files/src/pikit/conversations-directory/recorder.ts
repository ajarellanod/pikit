/**
 * The recorder, in each conversation's App: the runtime's events made updates (`update.ts`) and
 * given to the directory, off the message's path where the directory is another actor.
 *
 * - `agent.dispatched` (not a duplicate): activity by its sender (shown to people unless it is an
 *   operator's request, `isDashboardRequest`), the agent; the first time this App sees a conversation,
 *   its place, read from `conversations.registry` (channel, space, owner, whether it is the key's
 *   current) and whether it is delegated (`origin`).
 * - `agent.started`: busy. `agent.settled` / `agent.failed`: not busy, activity by the agent (shown
 *   unless the run answers only operators, `answersOnlyTheDashboard`).
 * - `conversation.reset`: the previous conversation not current, the new one recorded with its place.
 *
 * Where it goes (`Sink`): on a server the directory in this App, at once (`direct`); on Cloudflare the
 * conversation's own `_outbox`, one row per conversation merged (`mergeUpdate`: a burst of events is one
 * row), and a wakeup (`conversations-directory.flush`) that sends every row as one `seen` to the
 * directory's actor and deletes what it sent (`outbox`). A message's path costs one local write.
 *
 * Events can be missed (K3): `backfill`, at start, gives the directory the conversations
 * `agent.observe` holds that this App never told it (a server's every one, an object's own), without a
 * call when there is nothing new.
 */

import type { AppContext } from "@pikit/core";
import {
  type ActorMailbox,
  type AgentObserver,
  answersOnlyTheDashboard,
  type ConversationRef,
  type ConversationRegistry,
  isDashboardRequest,
  principalKey,
  type SqlDatabase,
  type Wakeups,
} from "@pikit/contracts";
import { INDEX_KEY, SEEN } from "./client.ts";
import type { DirectoryStore } from "./directory.ts";
import { ENTRIES, OUTBOX, TITLES } from "./tables.ts";
import { mergeUpdate, type Place, SEEN_MAX, type Update } from "./update.ts";

/** The wakeup that sends the outbox to the directory (Cloudflare). */
export const FLUSH = "conversations-directory.flush";
/** The prefix of tool-delegate's keys: a delegated task's conversation. */
const DELEGATE_KEY_PREFIX = "delegate:";
const BACKFILL_PAGE = 100;

/** Where updates go, and whether this App told the directory of a conversation already. */
export interface Sink {
  write(updates: readonly Update[], ctx: AppContext): Promise<void>;
  told(key: string, conversationId: string): Promise<boolean>;
}

/** The directory in this App (a server's). */
export function directSink(store: DirectoryStore, db: () => Promise<SqlDatabase>): Sink {
  return {
    write: (updates) => store.seen(updates),
    async told(key, conversationId) {
      const rows = await (await db()).query(`SELECT 1 AS told FROM ${ENTRIES} WHERE key = ? AND conversation = ? AND channel IS NOT NULL`, [key, conversationId]);
      return rows.length > 0;
    },
  };
}

/** The conversation's `_outbox`, flushed to the directory's actor by a wakeup (Cloudflare). */
export function outboxSink(local: () => Promise<SqlDatabase>, wakeups: () => Wakeups, now: () => number): Sink {
  return {
    async write(updates, ctx) {
      if (updates.length === 0) return;
      const database = await local();
      await database.transaction(async (tx) => {
        for (const update of updates) {
          const [row] = await tx.query<{ patch: string }>(`SELECT patch FROM ${OUTBOX} WHERE key = ? AND conversation = ?`, [update.key, update.conversationId]);
          const merged = row === undefined ? update : mergeUpdate(JSON.parse(row.patch) as Update, update);
          await tx.run(
            `INSERT INTO ${OUTBOX} (key, conversation, patch, seq) VALUES (?, ?, ?, ?) ON CONFLICT (key, conversation) DO UPDATE SET patch = excluded.patch, seq = excluded.seq`,
            [update.key, update.conversationId, JSON.stringify(merged), merged.seq],
          );
          // The record that this App told the directory of it (what the start's backfill reads).
          if (update.place !== undefined) await tx.run(`INSERT INTO ${TITLES} (key, conversation) VALUES (?, ?) ON CONFLICT (key, conversation) DO NOTHING`, [update.key, update.conversationId]);
        }
      });
      await wakeups().at(FLUSH, now(), ctx);
    },
    async told(key, conversationId) {
      const rows = await (await local()).query(`SELECT 1 AS told FROM ${TITLES} WHERE key = ? AND conversation = ?`, [key, conversationId]);
      return rows.length > 0;
    },
  };
}

/**
 * The flush: every row of the outbox (at most `SEEN_MAX`) as one `seen`, then each row deleted unless
 * an event changed it meanwhile (its `seq`): that one goes with the next flush. A failure is retried by
 * `wakeups`' backoff; a `seen` sent twice changes nothing.
 */
export async function flush(local: () => Promise<SqlDatabase>, mailbox: ActorMailbox, wakeups: Wakeups, now: () => number, ctx: AppContext): Promise<void> {
  const database = await local();
  const rows = await database.query<{ key: string; conversation: string; patch: string; seq: number }>(`SELECT key, conversation, patch, seq FROM ${OUTBOX} ORDER BY seq LIMIT ${SEEN_MAX + 1}`);
  if (rows.length === 0) return;
  const sent = rows.slice(0, SEEN_MAX);
  await mailbox.send(INDEX_KEY, SEEN, { updates: sent.map((row) => JSON.parse(row.patch)) }, ctx);
  for (const row of sent) await database.run(`DELETE FROM ${OUTBOX} WHERE key = ? AND conversation = ? AND seq = ?`, [row.key, row.conversation, row.seq]);
  if (rows.length > SEEN_MAX) await wakeups.at(FLUSH, now(), ctx);
}

/** Whether the outbox holds anything (asked at start: a flush the last App did not finish). */
export async function pending(local: () => Promise<SqlDatabase>): Promise<boolean> {
  return (await (await local()).query(`SELECT 1 AS pending FROM ${OUTBOX} LIMIT 1`)).length > 0;
}

export interface RecorderOptions {
  sink(): Sink;
  registry(): ConversationRegistry;
  observe(): AgentObserver;
  seq(): number;
  now(): number;
}

/** The place of `conversation` as its key's registry record has it. */
export async function placeOf(registry: ConversationRegistry, conversation: Omit<ConversationRef, "agent"> & { agent: string }, at: number, ctx: AppContext): Promise<Place> {
  const record = await registry.get(conversation.key, ctx);
  const space = record?.space ?? conversation.space;
  const owner = record?.owner;
  return {
    agent: conversation.agent,
    channel: record?.channel ?? conversation.channel ?? "unknown",
    ...(space !== undefined && { space }),
    ...(owner !== undefined && { owner: { channel: owner.channel, id: owner.id } }),
    delegated: conversation.origin !== undefined || conversation.key.startsWith(DELEGATE_KEY_PREFIX),
    current: record === undefined || record.conversationId === conversation.conversationId,
    at,
  };
}

export function createRecorder(options: RecorderOptions) {
  /** Conversations whose place this App gave already, in its life: the next update carries none. */
  const placed = new Set<string>();
  const idOf = (key: string, conversationId: string) => JSON.stringify([key, conversationId]);

  /** Gives `updates` to the directory; a failure is logged (the next activity or start tells it again). */
  const write = async (updates: Update[], ctx: AppContext): Promise<void> => {
    try {
      await options.sink().write(updates, ctx);
      for (const update of updates) if (update.place !== undefined) placed.add(idOf(update.key, update.conversationId));
    } catch (error) {
      ctx.logger.warn("conversations-directory: the directory was not told of this conversation's activity; its next activity or the next start tells it", {
        conversation: updates[0]?.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** An update of `conversation`, with its place the first time this App sees it. */
  const updateOf = async (conversation: ConversationRef, ctx: AppContext, fields: Omit<Update, "key" | "conversationId" | "seq">): Promise<Update> => {
    const update: Update = { key: conversation.key, conversationId: conversation.conversationId, seq: options.seq(), ...fields };
    if (!placed.has(idOf(conversation.key, conversation.conversationId))) {
      try {
        update.place = await placeOf(options.registry(), conversation, options.now(), ctx);
      } catch (error) {
        ctx.logger.warn("conversations-directory: a conversation's place was not read; its next update carries it", { conversation: conversation.key, error: String(error) });
      }
    }
    return update;
  };

  return {
    write,

    async dispatched({ conversation, admission, sender }: { conversation: ConversationRef; admission: { kind: string; requestId: string }; sender?: { channel: string; id: string } }, ctx: AppContext) {
      if (admission.kind === "duplicate") return;
      const by = sender === undefined ? "unknown" : principalKey({ channel: sender.channel, id: sender.id });
      const activity = [{ id: `m:${admission.requestId}`, at: options.now(), by, shown: !isDashboardRequest(admission.requestId) }];
      await write([await updateOf(conversation, ctx, { agent: conversation.agent, activity })], ctx);
    },

    async started({ conversation }: { conversation: ConversationRef }, ctx: AppContext) {
      await write([await updateOf(conversation, ctx, { busy: true })], ctx);
    },

    async ended(result: { conversation: ConversationRef; requestId: string; requestIds: string[] }, ctx: AppContext) {
      const activity = [{ id: `r:${result.requestId}`, at: options.now(), by: "agent", shown: !answersOnlyTheDashboard(result) }];
      await write([await updateOf(result.conversation, ctx, { busy: false, activity })], ctx);
    },

    async reset({ conversation, previousConversationId }: { conversation: ConversationRef; previousConversationId: string }, ctx: AppContext) {
      await write(resetUpdates(conversation, previousConversationId, options.seq, options.now()), ctx);
    },

    /**
     * The conversations `agent.observe` holds that this App never told the directory of: their place
     * and newest activity (no activity of their own: `touched`). Answers the ones it told, for titles.
     */
    async backfill(ctx: AppContext): Promise<{ key: string; conversationId: string; agent: string; at: number }[]> {
      const found: { key: string; conversationId: string; agent: string; at: number }[] = [];
      let cursor: string | undefined;
      do {
        if (ctx.abortSignal?.aborted === true) break;
        const page = await options.observe().conversations({ limit: BACKFILL_PAGE, ...(cursor !== undefined && { cursor }) }, ctx);
        const updates: Update[] = [];
        for (const { key, agent, conversationId, lastActivity } of page.items) {
          if (key === undefined || agent === undefined || (await options.sink().told(key, conversationId))) continue;
          const at = lastActivity ?? 0;
          const place = await placeOf(options.registry(), { key, agent, conversationId }, at > 0 ? at : options.now(), ctx);
          updates.push({ key, conversationId, seq: options.seq(), agent, place, ...(at > 0 && { touched: at }) });
          found.push({ key, conversationId, agent, at });
        }
        if (updates.length > 0) await options.sink().write(updates, ctx);
        cursor = page.next;
      } while (cursor !== undefined);
      return found;
    },
  };
}

/** What a reset says: the previous conversation not current, the new one recorded with its place (the registry's ref has it). */
export function resetUpdates(conversation: ConversationRef, previousConversationId: string, seq: () => number, at: number): Update[] {
  const { key, conversationId, agent, channel, space, owner } = conversation;
  const place: Place = {
    agent,
    channel: channel ?? "unknown",
    ...(space !== undefined && { space }),
    ...(owner !== undefined && { owner: { channel: owner.channel, id: owner.id } }),
    delegated: conversation.origin !== undefined || key.startsWith(DELEGATE_KEY_PREFIX),
    current: true,
    at,
  };
  return [
    { key, conversationId: previousConversationId, seq: seq(), current: false },
    { key, conversationId, seq: seq(), agent, place },
  ];
}
