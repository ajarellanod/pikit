/**
 * The titler: a model's title for each conversation (`model.complete`; without it, none), once, in the
 * conversation's App, in a wakeup (`conversations-directory.title`, never a promise outliving an event:
 * C4), with its answer sent as any update (the outbox on Cloudflare).
 *
 * - **When**: after the conversation's first completed run that a person's request started (never one
 *   an operator's request started, `isDashboardRequest`); at start for at most `retitleAtStart`
 *   conversations the backfill found, the most recently active first.
 * - **From what**: the `first` title's text a channel gave (`title(first)`: the first message as its
 *   person wrote it), else the first user text of that run (the operator's note line taken off), else
 *   the conversation's first user text read from `agent.observe`. At most `TITLE_INPUT` characters.
 * - **Tries**: each is recorded in `_titles` before the model is called; at most `TITLE_TRIES`, a failed
 *   one tried again after a later run. A conversation the directory already shows with a model's or a
 *   rename's title is not titled (no model call).
 * - **The model**: `titleModel` when set, else the conversation's agent's.
 */

import type { AppContext } from "@pikit/core";
import { type AgentObserver, type AgentResult, cleanTitle, type DirectoryEntry, type EntryRef, isDashboardRequest, type ModelComplete, type SqlDatabase } from "@pikit/contracts";
import { TITLES } from "./tables.ts";
import type { Update } from "./update.ts";

/** What the model is told. */
export const TITLE_SYSTEM =
  "You title conversations. Reply with a title of 2 to 6 words for the conversation that starts with the user's message, " +
  "in the language of that message. Reply with the title only: no quotes, no punctuation at the end, no explanation.";
/** The longest text a model is asked to title, in characters. */
export const TITLE_INPUT = 1_000;
/** The most tokens a title may take. */
export const TITLE_TOKENS = 32;
/** A model is asked to title a conversation at most this often: once, and once more if that failed. */
export const TITLE_TRIES = 2;
/** The line an operator's message from the dashboard starts with (admin-api's `OPERATOR_NOTE`): never titled from. */
export const OPERATOR_NOTE = "[From the operator, in the pikit dashboard";
/** Conversations titled per run of the wakeup, before it asks to run again. */
const PER_RUN = 10;

/** What was written in a user message (pi-ai's JSON), without the operator's note line; `undefined` for another. */
export function userTextOf(message: unknown): string | undefined {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "user") return undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
        : "";
  if (!text.startsWith(OPERATOR_NOTE)) return text;
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}

/** The first text a user wrote among `messages`, trimmed, at most `TITLE_INPUT` characters. */
export function firstTextOf(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    const text = userTextOf(message)?.trim();
    if (text !== undefined && text !== "") return text.slice(0, TITLE_INPUT);
  }
  return undefined;
}

export interface TitlerOptions {
  local(): Promise<SqlDatabase>;
  complete(): ModelComplete | undefined;
  modelFor(agent: string): string | undefined;
  observe(): AgentObserver;
  /** The conversation as the directory has it now (a component's view), when it has it. */
  entry(ref: EntryRef, ctx: AppContext): Promise<DirectoryEntry | undefined>;
  /** Sends a title like any update (direct on a server, through the outbox on Cloudflare). */
  write(update: Update, ctx: AppContext): Promise<void>;
  seq(): number;
  now(): number;
  /** Asks for the wakeup to run (`run`) now. */
  kick(ctx: AppContext): Promise<void>;
}

type TitleRow = { key: string; conversation: string; agent: string | null; input: string | null; tries: number };

/** A conversation's first user text, read from its transcript (oldest first, through at most 50 pages). */
async function firstTextFromObserve(observer: AgentObserver, conversationId: string, ctx: AppContext): Promise<string | undefined> {
  let cursor: string | undefined;
  let last: readonly { messages: readonly unknown[] }[] = [];
  for (let pages = 0; pages < 50; pages++) {
    const page = await observer.transcript(conversationId, { limit: 100, ...(cursor !== undefined && { cursor }) }, ctx);
    if (page === undefined) return undefined;
    last = page.items;
    cursor = page.next;
    if (cursor === undefined) break;
  }
  return firstTextOf([...last].reverse().flatMap((entry) => entry.messages));
}

export function createTitler(options: TitlerOptions) {
  /** Conversations this App knows are titled or past their tries: no write for their next runs. */
  const finished = new Set<string>();
  const idOf = (ref: { key: string; conversationId: string }) => JSON.stringify([ref.key, ref.conversationId]);
  const mark = async (row: { key: string; conversation: string }, fields: string, params: unknown[] = []) =>
    (await options.local()).run(`UPDATE ${TITLES} SET ${fields} WHERE key = ? AND conversation = ?`, [...(params as never[]), row.key, row.conversation]);

  return {
    /** After a run settled: due for a title when it is its first completed run a person started. Never throws. */
    async settled(result: AgentResult, ctx: AppContext): Promise<void> {
      const ref = result.conversation;
      if (result.kind !== "completed" || isDashboardRequest(result.requestId) || options.complete() === undefined || finished.has(idOf(ref))) return;
      try {
        const database = await options.local();
        const [row] = await database.query<{ done: number; tries: number }>(`SELECT done, tries FROM ${TITLES} WHERE key = ? AND conversation = ?`, [ref.key, ref.conversationId]);
        if (row !== undefined && (Number(row.done) === 1 || Number(row.tries) >= TITLE_TRIES)) {
          finished.add(idOf(ref));
          return;
        }
        await database.run(
          `INSERT INTO ${TITLES} (key, conversation, agent, input, due) VALUES (?, ?, ?, ?, 1) ON CONFLICT (key, conversation) DO UPDATE SET due = 1, ` +
            `agent = COALESCE(${TITLES}.agent, excluded.agent), input = COALESCE(${TITLES}.input, excluded.input)`,
          [ref.key, ref.conversationId, ref.agent, firstTextOf(result.messages as unknown[]) ?? null],
        );
        await options.kick(ctx);
      } catch (error) {
        ctx.logger.warn("conversations-directory: a conversation was not put up for a title; a later run tries again", { conversation: ref.key, error: String(error) });
      }
    },

    /** A channel's first message (`title(first)`): the text a model titles it from. */
    async first(ref: EntryRef, text: string): Promise<void> {
      const input = text.trim().slice(0, TITLE_INPUT);
      if (input === "") return;
      await (await options.local()).run(
        `INSERT INTO ${TITLES} (key, conversation, input) VALUES (?, ?, ?) ON CONFLICT (key, conversation) DO UPDATE SET input = excluded.input WHERE ${TITLES}.done = 0 AND ${TITLES}.tries = 0`,
        [ref.key, ref.conversationId, input],
      );
    },

    /** Puts `conversations` (the start's backfill) up for a title, unless titled or past their tries. */
    async enqueue(conversations: readonly { key: string; conversationId: string; agent: string }[], ctx: AppContext): Promise<void> {
      if (conversations.length === 0 || options.complete() === undefined) return;
      const database = await options.local();
      for (const { key, conversationId, agent } of conversations) {
        await database.run(
          `INSERT INTO ${TITLES} (key, conversation, agent, due) VALUES (?, ?, ?, 1) ON CONFLICT (key, conversation) DO UPDATE SET due = 1, agent = COALESCE(${TITLES}.agent, excluded.agent) ` +
            `WHERE ${TITLES}.done = 0 AND ${TITLES}.tries < ${TITLE_TRIES}`,
          [key, conversationId, agent],
        );
      }
      await options.kick(ctx);
    },

    /** The wakeup: titles the conversations due, a few per run. */
    async run(ctx: AppContext): Promise<void> {
      const complete = options.complete();
      const database = await options.local();
      const rows = await database.query<TitleRow>(`SELECT key, conversation, agent, input, tries FROM ${TITLES} WHERE due = 1 AND done = 0 LIMIT ${PER_RUN + 1}`);
      for (const row of rows.slice(0, PER_RUN)) {
        if (ctx.abortSignal?.aborted === true) return void (await options.kick(ctx));
        const ref = { key: row.key, conversationId: row.conversation };
        const model = row.agent === null ? undefined : options.modelFor(row.agent);
        if (complete === undefined || model === undefined || Number(row.tries) >= TITLE_TRIES) {
          await mark(row, "due = 0");
          continue;
        }
        const listed = await options.entry(ref, ctx);
        if (listed?.titleSource === "model" || listed?.titleSource === "rename") {
          await mark(row, "due = 0, done = 1");
          finished.add(idOf(ref));
          continue;
        }
        const input = row.input ?? (await firstTextFromObserve(options.observe(), row.conversation, ctx));
        if (input === undefined) {
          await mark(row, "due = 0");
          continue;
        }
        // The try is recorded before the model is called: a crash in between costs a try, never a second call.
        await mark(row, "due = 0, tries = tries + 1, input = ?", [input]);
        try {
          const made = cleanTitle(await complete.complete({ model, system: TITLE_SYSTEM, prompt: input.slice(0, TITLE_INPUT), maxTokens: TITLE_TOKENS }, ctx));
          if (made === undefined) throw new Error("the model's answer had no title in it");
          await options.write({ ...ref, seq: options.seq(), title: { text: made, source: "model", at: options.now() } }, ctx);
          await mark(row, "done = 1");
          finished.add(idOf(ref));
          ctx.logger.info("conversations-directory: a model titled a conversation", { conversation: row.key, model });
        } catch (error) {
          ctx.logger.warn("conversations-directory: a model did not title this conversation; it is tried again after a later run", {
            conversation: row.key,
            model,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (rows.length > PER_RUN) await options.kick(ctx);
    },
  };
}
