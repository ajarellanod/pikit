/**
 * memory-summaries: a summary of each conversation that went quiet, kept in the memory of its person
 * (`memory`, memory-sql's `contract.ts`, kind `summary`), which memory-recall's section shows.
 *
 * - **What starts it is the answers feed**, never an event alone nor `stop` (K3, K6): it reads
 *   `agent.submissions`' `answers` from its own cursor, and marks the conversation of each settled run
 *   of the configured `agents` due `idleMinutes` later, with the cursor, in one transaction (`memory_summaries_conversations`, `memory_summaries_cursor`). A run that settles later
 *   moves the conversation's due time again: new activity postpones its summary. A gap (runs pruned
 *   before it read them) is logged once, and those conversations are summarized after their next run.
 * - **One wakeup, `memory-summaries`**, reads the feed and summarizes what is due, then asks again for
 *   the earliest due time. A run settling wakes it at once; so does `start` (wakeups-timers keeps no
 *   request across a restart). A conversation with a request still pending (a run going, a message
 *   queued) is postponed.
 * - **What is summarized** is what the conversation said since its last summary (`agent.observe`'s
 *   transcript, newest first, back to the last entry summarized): at most `MAX_ENTRIES` entries and the
 *   newest `MAX_INPUT` characters of the person's and the assistant's text. Credentials are redacted
 *   from it before the model reads it, and from the model's answer before it is kept (`redact`: each
 *   word with a known credential's shape, `credentialSettingProblem`'s); an answer that still holds one
 *   (a private key's block) is not kept, and logged. Nothing new, nothing kept.
 * - **Idempotent**: the summary's id is `summary:<conversationId>:<newest entry id>`, so a wakeup that
 *   runs again, or a restart between keeping it and recording it, keeps it once (memory's `remember`
 *   is idempotent by id). A failure (the model, the store) is logged and that conversation tried
 *   again `idleMinutes` later; the others go on.
 * - **Logs never carry a transcript or a summary.**
 *
 * Targets: `server`.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { credentialSettingProblem, type JsonValue, type SqlRow, type TranscriptEntry } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import { MEMORY_TEXT_MAX } from "./contract.ts";

/** The wakeup's name, and the name of this component's state. */
export const WAKEUP = "memory-summaries";
export const CONVERSATIONS = "memory_summaries_conversations";
export const CURSOR = "memory_summaries_cursor";
/** Settlements read from the feed at once. */
export const FEED_PAGE = 100;
/** Conversations summarized in one run of the wakeup; the rest in the next, at once. */
export const BATCH = 10;
/** The most transcript entries one summary reads. */
export const MAX_ENTRIES = 200;
/** The most characters of conversation one summary reads: the newest. */
export const MAX_INPUT = 24_000;
/** The most tokens a summary may take. */
export const SUMMARY_TOKENS = 600;
/** What a redacted credential becomes. */
export const REDACTED = "[redacted]";

/** What the model is told. */
export const SUMMARY_SYSTEM =
  "You summarize a conversation between a person and an assistant, for the assistant's memory of that person. " +
  "In at most 6 short lines, in the language of the conversation: what the person wanted, what was decided or done, " +
  "lasting facts about the person, and what is still pending. Never include passwords, keys, tokens or other secrets. Reply with the summary only.";

const Config = Type.Object({
  /** `provider/modelId` of the model that writes the summaries (checked at start). */
  model: Type.String({ minLength: 3 }),
  /** The agents whose conversations are summarized: those that name the `memory` extension. */
  agents: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  /** How long a conversation stays quiet before it is summarized. */
  idleMinutes: Type.Integer({ minimum: 1, maximum: 10_080, default: 30 }),
});

export type MemorySummariesConfig = Static<typeof Config>;

/** `text` with every word that has a known credential's shape replaced by `REDACTED`. */
export const redact = (text: string): string => text.replace(/\S+/g, (word) => (credentialSettingProblem(word) === undefined ? word : REDACTED));

/** What a pi-ai message said, as one line of a transcript; `undefined` for a tool's result or a message with no text. */
function spoken(message: JsonValue): string | undefined {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "user" && role !== "assistant") return undefined;
  const text = (
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
        : ""
  ).trim();
  return text === "" ? undefined : `${role === "user" ? "Person" : "Assistant"}: ${text}`;
}

/** The text of `entries` (oldest first): what the person and the assistant said, its newest `MAX_INPUT` characters. */
export function transcriptText(entries: readonly TranscriptEntry[]): string {
  return entries
    .flatMap((entry) => entry.messages.flatMap((message) => spoken(message) ?? []))
    .join("\n")
    .slice(-MAX_INPUT);
}

export default defineComponent({
  name: "memory-summaries",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const wakeups = pikit.use("wakeups");
    const submissions = pikit.use("agent.submissions");
    const observe = pikit.use("agent.observe");
    const complete = pikit.use("model.complete");
    const memory = pikit.use("memory");
    const idleMs = config.idleMinutes * 60_000;

    let app: AppContext | undefined;
    /** A run settled since the wakeup's run began: it asks to run again at once, not at the next due time. */
    let kicked = false;
    /** The cursor after which a gap was last logged: each gap once. */
    let gapAfter: string | undefined | null = null;

    const kick = () => {
      const ctx = app;
      if (ctx === undefined) return;
      kicked = true;
      wakeups
        .get()
        .at(WAKEUP, ctx.clock.now(), ctx)
        .catch((error: unknown) => ctx.logger.warn("memory-summaries: could not ask for its wakeup; it reads the feed at its next one", { error: String(error) }));
    };
    pikit.on("agent.settled", kick);
    pikit.on("agent.failed", kick);

    /** Records the settled runs after the cursor: each one's conversation due `idleMs` from now, and the cursor, together. */
    const ingest = async (ctx: AppContext): Promise<void> => {
      const [saved] = await sql.get().query(`SELECT cursor FROM ${CURSOR} WHERE name = 'answers'`);
      let after = saved === undefined ? undefined : String(saved.cursor);
      for (;;) {
        const page = await submissions.get().answers.read(after, FEED_PAGE);
        if (page.gap && gapAfter !== after) {
          gapAfter = after;
          ctx.logger.warn("memory-summaries: runs were pruned before it read them; their conversations are summarized after their next run");
        }
        const last = page.items.at(-1);
        if (last === undefined) return;
        const due = ctx.clock.now() + idleMs;
        await sql.get().transaction(async (tx) => {
          for (const { fact } of page.items) {
            const { conversationId, key, agent } = fact.conversation;
            if (!config.agents.includes(agent)) continue;
            await tx.run(
              `INSERT INTO ${CONVERSATIONS} (conversation_id, conversation_key, agent, due) VALUES (?, ?, ?, ?) ON CONFLICT (conversation_id) DO UPDATE SET due = excluded.due`,
              [conversationId, key, agent, due],
            );
          }
          await tx.run(`INSERT INTO ${CURSOR} (name, cursor) VALUES ('answers', ?) ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor`, [last.cursor]);
        });
        after = last.cursor;
        if (page.items.length < FEED_PAGE) return;
      }
    };

    /** What `conversationId` said after the entry `since`, and its newest entry; `undefined` when the runtime does not know it. */
    const readSince = async (conversationId: string, since: string | undefined, ctx: AppContext) => {
      const entries: TranscriptEntry[] = [];
      let cursor: string | undefined;
      reading: while (entries.length < MAX_ENTRIES) {
        const page = await observe.get().transcript(conversationId, { limit: Math.min(50, MAX_ENTRIES - entries.length), ...(cursor !== undefined && { cursor }) }, ctx);
        if (page === undefined) return undefined;
        for (const entry of page.items) {
          if (entry.id === since) break reading;
          entries.push(entry);
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      return { newest: entries[0]?.id, text: transcriptText(entries.reverse()) };
    };

    /** Summarizes one due conversation into its person's memory, or postpones it. */
    const summarize = async (row: SqlRow, busy: boolean, ctx: AppContext): Promise<void> => {
      const conversationId = String(row.conversation_id);
      // The wakeup's runs never overlap: no run's ingest moves a due time while this one decides.
      const postpone = () => sql.get().run(`UPDATE ${CONVERSATIONS} SET due = ? WHERE conversation_id = ?`, [ctx.clock.now() + idleMs, conversationId]);
      if (busy) return void (await postpone());
      const fields = { conversation: String(row.conversation_key), conversationId };
      try {
        const read = await readSince(conversationId, row.summarized_entry === null ? undefined : String(row.summarized_entry), ctx);
        if (read?.newest !== undefined && read.text !== "") {
          const answer = await complete.get().complete({ model: config.model, system: SUMMARY_SYSTEM, prompt: redact(read.text), maxTokens: SUMMARY_TOKENS }, ctx);
          const text = redact(answer.trim()).slice(0, MEMORY_TEXT_MAX).trim();
          if (text === "") ctx.logger.warn("memory-summaries: the model's summary was empty; nothing kept", fields);
          else if (credentialSettingProblem(text) !== undefined) ctx.logger.warn("memory-summaries: the summary still looked like it held a credential; nothing kept", fields);
          else {
            const scope = { agent: String(row.agent), person: String(row.conversation_key) };
            await memory.get().remember(scope, { id: `summary:${conversationId}:${read.newest}`, kind: "summary", text, createdAt: ctx.clock.now() }, ctx);
          }
        }
        await sql.get().run(`UPDATE ${CONVERSATIONS} SET summarized_entry = COALESCE(?, summarized_entry), due = NULL WHERE conversation_id = ?`, [read?.newest ?? null, conversationId]);
      } catch (error) {
        ctx.logger.warn("memory-summaries: a conversation could not be summarized; it is tried again later", { ...fields, error: error instanceof Error ? error.message : String(error) });
        await postpone();
      }
    };

    const run = async (ctx: AppContext): Promise<void> => {
      kicked = false;
      await ingest(ctx);
      const due = await sql
        .get()
        .query(`SELECT conversation_id, conversation_key, agent, summarized_entry FROM ${CONVERSATIONS} WHERE due IS NOT NULL AND due <= ? ORDER BY due LIMIT ?`, [
          ctx.clock.now(),
          BATCH,
        ]);
      if (due.length > 0) {
        const pending = new Set((await submissions.get().pending(ctx)).map((each) => each.conversation.conversationId));
        for (const row of due) {
          if (ctx.abortSignal?.aborted === true) break;
          await summarize(row, pending.has(String(row.conversation_id)), ctx);
        }
      }
      const [next] = await sql.get().query(`SELECT MIN(due) AS due FROM ${CONVERSATIONS} WHERE due IS NOT NULL`);
      // Read and decided with no await in between: a run settled meanwhile is never left for later.
      const at = kicked ? ctx.clock.now() : next?.due == null ? undefined : Number(next.due);
      if (at !== undefined) await wakeups.get().at(WAKEUP, at, ctx);
    };

    return {
      async start(ctx) {
        if (!/^[^/\s]+\/\S+$/.test(config.model)) throw new Error(`memory-summaries: "model" is provider/modelId, as an agent names one (got "${config.model}")`);
        await sql
          .get()
          .run(
            `CREATE TABLE IF NOT EXISTS ${CONVERSATIONS} (conversation_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, agent TEXT NOT NULL, ` +
              "due BIGINT, summarized_entry TEXT)",
          );
        await sql.get().run(`CREATE INDEX IF NOT EXISTS ${CONVERSATIONS}_due ON ${CONVERSATIONS} (due)`);
        await sql.get().run(`CREATE TABLE IF NOT EXISTS ${CURSOR} (name TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
        app = ctx.derive(() => BACKGROUND_CONTEXT);
        wakeups.get().handle(WAKEUP, run);
        // Requests may not survive a restart (wakeups-timers keeps none): read the feed and what is due now.
        await wakeups.get().at(WAKEUP, ctx.clock.now(), ctx);
      },
      stop() {
        app = undefined;
      },
    };
  },
});
