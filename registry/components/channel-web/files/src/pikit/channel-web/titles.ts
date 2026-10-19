/**
 * A web conversation's title, the one its user sees and the dashboard lists (features/completed/chat-parity.md, "Titles").
 *
 * - **At creation** its first message names it (`firstTitle`, `chat.ts`).
 * - **After its first run that settles** (completed, answering the user), a model titles it, in the
 *   background (no request or event waits for it), through `model.complete` (runtime-pi's; without it,
 *   none): `titleModel` when set, else the conversation's agent's model, told `TITLE_SYSTEM` and the
 *   first message's text (at most `TITLE_INPUT` characters; a first message of images only keeps its
 *   first title). Its answer is cleaned (`cleanTitle`); one with nothing left is a failure. Once: a
 *   failure is logged and tried once more after a later run (`TITLE_TRIES`), then never.
 * - **The user's rename always wins**: a model never titles a conversation its user renamed, and its
 *   title is written only while the conversation still has the title it had when the model was asked
 *   (`whenTitle`), so a rename meanwhile is kept.
 * - **Whose the title is, and the tries**, are a record per conversation in the channel's
 *   `storage.kv` namespace (`title:<key>`, `TitleRecord`): no table changes. Absent: its first message's,
 *   no try yet.
 * - **The page** hears a model's title as any change (`notify`: the live view says the transcript
 *   changed, and the page reads the conversation and the list again); the users' index is told (`changed`).
 * - **One title in both apps.** Each title set here (the first message's, a model's, the user's) is also
 *   given to the App's `/name` (`agent.command` `"name"`, admin-api's, when installed), in the App that
 *   holds the conversation (on Cloudflare its object): the dashboard lists the same title, and, the
 *   conversation being named before its first run settles, asks no model of its own. The first title is
 *   given while its message is dispatched (`agent.dispatched`, before any run of it can settle), so the
 *   dashboard's titler always finds it named. An operator's `/name` there changes only the dashboard's
 *   title, until a title is set here again.
 */

import type { AppContext } from "@pikit/core";
import { type CommandLookup, type ConversationRef, type KeyValueStore, type ModelComplete, runAgentCommand } from "@pikit/contracts";
import { cleanTitle } from "./chat.ts";
import type { ChatStore, ConversationRow } from "./store.ts";

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
/** How long a run's end waits for its conversation's first message to be stored (a run can end before its admission returns). */
const FIRST_WAIT_MS = 2_000;

/** Whose a conversation's title is (`first`: its first message's), and the model's tries. JSON, in `storage.kv`. */
export type TitleRecord = { by: "first" | "model" | "user"; tries: number };
export const titleKey = (key: string): string => `title:${key}`;

export interface TitlesOptions {
  store: ChatStore;
  /** The channel's `storage.kv` namespace. */
  kv(): KeyValueStore;
  /** `model.complete`, when installed. */
  complete(): ModelComplete | undefined;
  /** The model a conversation of `agent` is titled with: `titleModel`, else the agent's (`undefined`: none). */
  modelFor(agent: string, ctx: AppContext): Promise<string | undefined>;
  /** The App's commands (`agent.command`): `/name` among them when admin-api is installed. */
  commands(): CommandLookup;
  /** The key's current conversation, for `/name`. */
  current(key: string, ctx: AppContext): Promise<ConversationRef | undefined>;
  /** A row changed: tell the users' index. Never rejects. */
  changed(row: ConversationRow, ctx: AppContext): Promise<void>;
}

export function createTitles(options: TitlesOptions) {
  const { store } = options;
  /** First titles of conversations being made here, by key, until their first message is dispatched. */
  const creating = new Map<string, string>();
  /** Keys being titled now, in this App: one try at a time. */
  const titling = new Set<string>();
  const work = new Set<Promise<void>>();

  const recordOf = async (key: string): Promise<TitleRecord> => (await options.kv().get<TitleRecord>(titleKey(key))) ?? { by: "first", tries: 0 };

  /** `title` given to the App's `/name` for `conversation`, when it has one: logged, never thrown. */
  const name = async (conversation: ConversationRef | undefined, title: string, ctx: AppContext): Promise<void> => {
    if (conversation === undefined) return;
    const outcome = await runAgentCommand(options.commands(), "name", conversation, title, ctx);
    if (outcome.kind === "failed") {
      ctx.logger.warn("channel-web: the App's /name did not take this conversation's title; the dashboard lists it by its own", { conversation: conversation.key, error: outcome.message });
    }
  };

  /** The text of `key`'s first message, waiting shortly for it to be stored; `undefined` when it never is. */
  const firstText = async (key: string): Promise<string | undefined> => {
    const deadline = Date.now() + FIRST_WAIT_MS;
    for (;;) {
      const text = await store.firstText(key);
      if (text !== undefined || Date.now() >= deadline) return text;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const title = async (conversation: ConversationRef, ctx: AppContext): Promise<void> => {
    const { key, agent } = conversation;
    const complete = options.complete();
    if (complete === undefined) return;
    const record = await recordOf(key);
    if (record.by !== "first" || record.tries >= TITLE_TRIES) return;
    const input = (await firstText(key))?.trim().slice(0, TITLE_INPUT);
    // Images only (or not stored): it keeps its first title.
    if (input === undefined || input === "") return;
    const row = await store.conversation(key);
    if (row === undefined || row.hidden) return;
    const model = await options.modelFor(agent, ctx);
    if (model === undefined) return;
    const tries = record.tries + 1;
    await options.kv().set(titleKey(key), { by: "first", tries });
    try {
      const made = cleanTitle(await complete.complete({ model, system: TITLE_SYSTEM, prompt: input, maxTokens: TITLE_TOKENS }, ctx));
      if (made === undefined) throw new Error("the model's answer had no title in it");
      // Renamed meanwhile: the user's stays.
      if ((await recordOf(key)).by !== "first") return;
      const titled = await store.change(key, { title: made, whenTitle: row.title });
      if (titled === undefined) return;
      await options.kv().set(titleKey(key), { by: "model", tries });
      store.notify(key, { type: "changed" });
      await options.changed(titled, ctx);
      await name((await options.current(key, ctx)) ?? conversation, made, ctx);
      ctx.logger.info("channel-web: a model titled a conversation", { conversation: key, model });
    } catch (error) {
      ctx.logger.warn("channel-web: a model did not title this conversation; it is tried once more after a later run", {
        conversation: key,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    /**
     * `key` is being made, `title` its first title: given to `/name` when its first message is
     * dispatched (`dispatched`). The returned function forgets it (once the admission returned).
     */
    creating(key: string, title: string): () => void {
      creating.set(key, title);
      return () => {
        if (creating.get(key) === title) creating.delete(key);
      };
    },
    /** `agent.dispatched` of a web conversation: one being made here is named in the App's `/name`, before any run of it settles. */
    async dispatched(conversation: ConversationRef, ctx: AppContext): Promise<void> {
      const first = creating.get(conversation.key);
      if (first !== undefined) await name(conversation, first, ctx);
    },
    /** The user renamed `key` (its row changed already): the dashboard lists their title too. */
    async renamed(key: string, title: string, ctx: AppContext): Promise<void> {
      await name(await options.current(key, ctx), title, ctx);
    },
    /**
     * `key` is being renamed by its user: its title is theirs from now on, marked before its row changes
     * so that a model's title under way never replaces it (`whenTitle` covers the rest).
     */
    async renaming(key: string): Promise<void> {
      const record = await recordOf(key);
      await options.kv().set(titleKey(key), { by: "user", tries: record.tries });
    },
    /** A run that answered the user's message completed in `conversation`: a model titles it, in the background, in `ctx` (one that outlives the event). */
    settled(conversation: ConversationRef, ctx: AppContext): void {
      if (titling.has(conversation.key) || options.complete() === undefined) return;
      titling.add(conversation.key);
      const done = title(conversation, ctx)
        .catch((error: unknown) =>
          ctx.logger.warn("channel-web: a conversation could not be titled", { conversation: conversation.key, error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => {
          titling.delete(conversation.key);
          work.delete(done);
        });
      work.add(done);
    },
    /** Resolves once the titles under way are done. */
    async idle(): Promise<void> {
      await Promise.all([...work]);
    },
  };
}
