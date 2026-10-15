/**
 * What the chat routes read and do, apart from where it is (`routes.ts` is written once, over this).
 * Every method takes a `ChatRef`, whose key the routes built with `keyOf` from the session's user: a
 * conversation of another user's is never named, and one this user does not have (never made, or
 * deleted from their list) is `not_found`, as is any whose row is not this user's.
 *
 * - **`createLocalBackend`**: the contracts of the App it runs in and the channel's store. On a server
 *   that is every conversation; in a Cloudflare Durable Object, that object's own (its answers to the
 *   Worker's calls, `calls.ts`).
 * - **`createRemoteBackend`** (`remote.ts`): the Worker's, a call to the conversation's object, and to
 *   the accounts actor for the list.
 *
 * **A message** goes through `admitInbound` (`inbound.normalize`, `route.resolve`, the conversation,
 * `dispatch`), its sender `{ channel: "web", id: <user id> }`, its images with it. Admitted (or a
 * duplicate: a retry), it is stored as the user's, `pending` (held while a run goes, `store.ts`);
 * refused, nothing is stored and the refusal is the route's status. A new conversation is made by its
 * first message admitted: one whose first message is refused does not exist. A new conversation with
 * an `agent` (one the user picked, checked by the route) is made with it in the registry before
 * (`conversations.registry.resolve`): routing still allows or denies the message, and a key keeps the
 * agent it was made with.
 *
 * **The transcript and the live events** are what the store and the runtime hold, every entry and run
 * the user's (`entries.ts`, `live.ts`): the routes cut them by the operator's policy (`visibility.ts`).
 *
 * A refusal is an `ActorCallError` whose code the routes answer with (`routes.ts`); it crosses a call
 * from an object to the Worker whole.
 */

import type { AppContext } from "@pikit/core";
import {
  ActorCallError,
  admitInbound,
  type AgentObserver,
  type AgentRuntime,
  type AgentSubmissions,
  type ConversationRegistry,
  type InboundOutcome,
} from "@pikit/contracts";
import type { ChatConversation, ChatEvent, ChatImage, ChatPage, ChatSendResponse, ChatTranscriptEntry } from "./api.ts";
import { CHANNEL, firstTitle, imagesProblem } from "./chat.ts";
import { userEntryOf } from "./entries.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, ConversationRow, EntryRow, ListQuery, MessageState } from "./store.ts";

/** A user's conversation, as the routes name it: the key is `keyOf(userId, chatId)`. JSON. */
export type ChatRef = { userId: string; chatId: string; key: string };

/** A user's message, checked by the route. JSON. */
export type NewMessage = { text: string; images?: ChatImage[]; requestId: string };

/** A conversation's first message, and the agent the user picked (one the route allowed). JSON. */
export type FirstMessage = NewMessage & { agent?: string };

export interface ChatBackend {
  /** The user's conversations, newest activity first (with `q`, those whose title holds it). Throws `invalid_cursor`. */
  list(userId: string, query: ListQuery, ctx: AppContext): Promise<ChatPage<ChatConversation>>;
  /** A new conversation, with its first message. Throws the admission's refusals (`denied`, `rejected`, `no_route`), `invalid_request`, `too_large`. */
  start(ref: ChatRef, message: FirstMessage, ctx: AppContext): Promise<ChatSendResponse>;
  /** Throws `not_found`. */
  conversation(ref: ChatRef, ctx: AppContext): Promise<ChatConversation>;
  rename(ref: ChatRef, title: string, ctx: AppContext): Promise<ChatConversation>;
  /** Archives it (`true`: listed apart) or puts it back in the list (`false`). Throws `not_found`. */
  archive(ref: ChatRef, archived: boolean, ctx: AppContext): Promise<ChatConversation>;
  /** Out of the user's list, and gone for them: nothing of the runtime's is deleted. */
  hide(ref: ChatRef, ctx: AppContext): Promise<void>;
  /** Newest first, every message as stored (the routes cut them by the policy). Throws `not_found`, `invalid_cursor`. */
  transcript(ref: ChatRef, page: { limit: number; cursor?: string }, ctx: AppContext): Promise<ChatPage<ChatTranscriptEntry>>;
  /** Image `index` of the user's message `messageId` (its request id). Throws `not_found`. */
  image(ref: ChatRef, messageId: string, index: number, ctx: AppContext): Promise<ChatImage>;
  /** Throws `not_found` and the admission's refusals. */
  send(ref: ChatRef, message: NewMessage, ctx: AppContext): Promise<ChatSendResponse>;
  /** The live events (`live.ts`), a `snapshot` first, until `ctx` is cancelled. Throws `not_found` before the first. */
  live(ref: ChatRef, ctx: AppContext): Promise<AsyncIterable<ChatEvent>>;
  /** Stops the run going, if one does. Throws `not_found`. */
  abort(ref: ChatRef, ctx: AppContext): Promise<void>;
  /** The user's conversations leave the list (the user was removed). */
  forget(userId: string, ctx: AppContext): Promise<void>;
}

export type RefusalCode = "not_found" | "invalid_request" | "invalid_cursor" | "too_large" | "denied" | "rejected" | "no_route";

export const refusal = (code: RefusalCode, message: string): ActorCallError => new ActorCallError(code, message);
export const NOT_FOUND = "no such conversation";

export interface LocalContracts {
  store: ChatStore;
  conversations(): ConversationRegistry;
  runtime(): AgentRuntime;
  observe(): AgentObserver;
  submissions(): AgentSubmissions;
  /** Where the conversations are, for the image limits (`imagesProblem`): `server`, or `durable` in a Durable Object (by `actor.inbox`'s scope). */
  limits(): "server" | "durable";
  /** A conversation's row changed: tell the users' index (on a server it is the same table: nothing to do). Never rejects. */
  changed(row: ConversationRow, ctx: AppContext): Promise<void>;
  /** A message was admitted: answers may be due soon. */
  wake(ctx: AppContext): Promise<void>;
}

const STATE_OF: Record<string, MessageState> = { completed: "answered", aborted: "aborted", failed: "failed" };
/** The state a run's end gives the user's messages it took. */
export const stateOf = (kind: string): MessageState => STATE_OF[kind] ?? "failed";

/** A row as the API says it. */
export const conversationOf = (row: ConversationRow, busy = row.busy): ChatConversation => ({
  id: row.chatId,
  title: row.title,
  busy,
  archived: row.archived,
  lastActivity: row.lastActivity,
  createdAt: row.createdAt,
  ...(row.agent !== "" && { agent: row.agent }),
});

/** A stored entry as the transcript says it (`entries.ts`): a user's message with its images by URL, a run's message as it wrote it. */
export const transcriptEntryOf = (chatId: string, row: EntryRow): ChatTranscriptEntry =>
  row.kind === "user" ? userEntryOf(chatId, row) : { id: row.id, kind: "message", messages: [row.message] };

/** The backend over the contracts of the App it runs in. */
export function createLocalBackend(contracts: LocalContracts): ChatBackend {
  const { store } = contracts;

  /** The row of `ref`, this user's and not deleted, or `not_found`. */
  const owned = async (ref: ChatRef): Promise<ConversationRow> => {
    const row = await store.conversation(ref.key);
    if (row === undefined || row.hidden || row.userId !== ref.userId || row.chatId !== ref.chatId) throw refusal("not_found", NOT_FOUND);
    return row;
  };

  /** Whether a run goes in the key's current conversation, by the runtime; the row's when it cannot say. */
  const busyOf = async (row: ConversationRow, ctx: AppContext): Promise<boolean> => {
    const current = await contracts.conversations().get(row.key, ctx);
    const observed = current === undefined ? undefined : await contracts.observe().conversation(current.conversationId, ctx);
    return observed?.busy ?? row.busy;
  };

  /** The messages held behind a run that ended unheard: in the transcript now, and told to who follows it live. */
  const releaseHeld = async (ref: ChatRef): Promise<void> => {
    for (const released of await store.release(ref.key)) store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, released) });
  };

  const refused = (outcome: Exclude<InboundOutcome, { kind: "admitted" | "duplicate" }>): ActorCallError => {
    if (outcome.kind === "denied") return refusal("denied", outcome.reason ?? "this assistant does not take your messages");
    if (outcome.kind === "halted") return refusal("rejected", outcome.reason);
    return refusal("no_route", "no agent answers here: the App has no router");
  };

  /**
   * `message` through the inbound path into `ref`'s conversation; stored once admitted. `create` makes
   * the conversation's row then (its first message's title).
   */
  const admit = async (ref: ChatRef, message: NewMessage, create: boolean, ctx: AppContext): Promise<ChatSendResponse> => {
    const images = message.images ?? [];
    const wrong = imagesProblem(images, contracts.limits());
    if (wrong !== undefined) throw refusal(wrong.status === 413 ? "too_large" : "invalid_request", wrong.message);
    // Before the admission: what its run writes is always later.
    const at = ctx.clock.now();
    const outcome = await admitInbound(
      ctx,
      { id: message.requestId, channel: CHANNEL, conversationId: `${ref.userId}:${ref.chatId}`, actor: { id: ref.userId }, text: message.text, ...(images.length > 0 && { images }) },
      { conversations: contracts.conversations(), runtime: contracts.runtime(), key: ref.key },
    );
    if (outcome.kind !== "admitted" && outcome.kind !== "duplicate") throw refused(outcome);
    const admitted = outcome.kind === "admitted";
    const conversationId = outcome.conversation.conversationId;
    if (create) {
      await store.create({ key: ref.key, userId: ref.userId, chatId: ref.chatId, agent: outcome.conversation.agent, title: firstTitle(message.text, images.length), createdAt: at, lastActivity: at, busy: admitted });
    }
    // Waiting behind a run going: out of the transcript until that run's messages are in it.
    const held = admitted && outcome.admission.kind === "queued";
    // A duplicate stores it too: a retry after a crash between the admission and this write.
    const stored = await store.addUser(ref.key, { id: message.requestId, text: message.text, ...(images.length > 0 && { images }), at, state: "pending", conversation: conversationId, held });
    if (stored && !held) store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, { id: message.requestId, text: message.text, imageTypes: images.map((image) => image.mimeType), at, state: "pending" }) });
    if (stored || admitted) {
      // The live view first, before telling the index (on Cloudflare a call to another object, while the
      // run, in this object's alarm, may already go on).
      let row = await store.change(ref.key, { activity: at, ...(admitted && { busy: true }) });
      if (admitted && row !== undefined) row = await endedEarly(ref, message.requestId, conversationId, row, ctx);
      if (row !== undefined) await contracts.changed(row, ctx);
    }
    // The run it waited behind ended while it was stored: nothing holds it now.
    if (held && (await contracts.observe().conversation(conversationId, ctx))?.busy === false) await releaseHeld(ref);
    if (admitted) await contracts.wake(ctx);
    return { requestId: message.requestId, admission: outcome.kind === "duplicate" ? "duplicate" : outcome.admission.kind };
  };

  /**
   * A run can end before its admission returns (Pi announces a quick run's `agent.started` and its end
   * as `dispatch` returns), so its end's `busy: false` and its message's state came before the row and
   * the message were written: they are set again from `agent.submissions`. Then, once more, from a run
   * started since (`startedBy`, set before its `busy: true` is written): whichever comes last, the row
   * says what goes.
   */
  const endedEarly = async (ref: ChatRef, requestId: string, conversationId: string, row: ConversationRow, ctx: AppContext): Promise<ConversationRow> => {
    if (store.startedBy(conversationId) !== undefined) return row;
    const status = await contracts.submissions().get({ conversationId }, requestId, ctx);
    if (status?.kind !== "settled") return row;
    if ((await store.settle(ref.key, [requestId], stateOf(status.run.kind))).length > 0) store.notify(ref.key, { type: "changed" });
    let now = (await store.change(ref.key, { busy: false })) ?? row;
    if (store.startedBy(conversationId) !== undefined) now = (await store.change(ref.key, { busy: true })) ?? now;
    return now;
  };

  /**
   * The page's pending messages whose run ended while no event reached this App (K3): their state
   * from `agent.submissions`, written back, and told to who follows the conversation live.
   */
  const reconcile = async (ref: ChatRef, items: EntryRow[], ctx: AppContext): Promise<EntryRow[]> => {
    const settled = new Map<string, MessageState>();
    for (const item of items) {
      if (item.kind !== "user" || item.state !== "pending" || item.conversation === undefined) continue;
      const status = await contracts.submissions().get({ conversationId: item.conversation }, item.id, ctx);
      if (status?.kind === "settled") settled.set(item.id, stateOf(status.run.kind));
    }
    if (settled.size === 0) return items;
    let moved = 0;
    for (const [id, state] of settled) moved += (await store.settle(ref.key, [id], state)).length;
    if (moved > 0) store.notify(ref.key, { type: "changed" });
    return items.map((item) => (item.kind === "user" && settled.has(item.id) ? { ...item, state: settled.get(item.id) as MessageState } : item));
  };

  return {
    async list(userId, query) {
      const listed = await store.list(userId, query);
      return { items: listed.items.map((row) => conversationOf(row)), ...(listed.next !== undefined && { next: listed.next }) };
    },

    async start(ref, { agent, ...message }, ctx) {
      const row = await store.conversation(ref.key);
      // A retry of the same first message (its chat id is the request id's): the same conversation.
      if (row !== undefined && (row.hidden || row.userId !== ref.userId)) throw refusal("not_found", NOT_FOUND);
      // Made with the agent picked: admitInbound's resolve then finds it, whatever the router names.
      if (row === undefined && agent !== undefined) await contracts.conversations().resolve(ref.key, agent, CHANNEL, ctx);
      return admit(ref, message, row === undefined, ctx);
    },

    async conversation(ref, ctx) {
      const row = await owned(ref);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async rename(ref, title, ctx) {
      await owned(ref);
      const row = (await store.change(ref.key, { title })) as ConversationRow;
      await contracts.changed(row, ctx);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async archive(ref, archived, ctx) {
      await owned(ref);
      const row = (await store.change(ref.key, { archived })) as ConversationRow;
      await contracts.changed(row, ctx);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async hide(ref, ctx) {
      await owned(ref);
      const row = await store.change(ref.key, { hidden: true });
      if (row !== undefined) await contracts.changed(row, ctx);
    },

    async transcript(ref, page, ctx) {
      const row = await owned(ref);
      // A message held behind a run whose end this App never heard: nothing runs now, so nothing holds it.
      if (page.cursor === undefined && !(await busyOf(row, ctx))) await releaseHeld(ref);
      const read = await store.entries(ref.key, page);
      const items = await reconcile(ref, read.items, ctx);
      return { items: items.map((item) => transcriptEntryOf(ref.chatId, item)), ...(read.next !== undefined && { next: read.next }) };
    },

    async image(ref, messageId, index) {
      await owned(ref);
      const found = await store.image(ref.key, messageId, index);
      if (found === undefined) throw refusal("not_found", "no such image");
      return found;
    },

    async send(ref, message, ctx) {
      await owned(ref);
      return admit(ref, message, false, ctx);
    },

    async live(ref, ctx) {
      await owned(ref);
      const current = await contracts.conversations().get(ref.key, ctx);
      return liveEvents({ observe: contracts.observe(), store, key: ref.key, conversationId: current?.conversationId }, ctx);
    },

    async abort(ref, ctx) {
      await owned(ref);
      const current = await contracts.conversations().get(ref.key, ctx);
      if (current !== undefined) await contracts.runtime().abort(current, ctx);
    },

    async forget(userId) {
      await store.forget(userId);
    },
  };
}
