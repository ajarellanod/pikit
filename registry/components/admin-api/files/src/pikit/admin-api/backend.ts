/**
 * What the admin API's routes read and do, apart from where it is (`routes.ts` is written once, over
 * this): the composition, conversations, a transcript, a conversation live, a message, an abort, a
 * reset.
 *
 * - **`createLocalBackend`**: the contracts of the App it runs in (`agent.observe`, `agent.runtime`,
 *   `conversations.registry`). On a server that is every conversation; in a Cloudflare Durable
 *   Object, that object's own, which its answers to the Worker's calls read (`calls.ts`).
 * - **`createRemoteBackend`** (`remote.ts`): the Worker's, which reaches each conversation's object by
 *   `actor.mailbox.call` and lists them from the index (`conversation-index.ts`).
 *
 * A refusal is an `ActorCallError` whose code the routes answer with (`not_found` is a `404`,
 * `no_agent` and `not_current` a `409`, `invalid_cursor` and `invalid_request` a `400`): the same error
 * crosses a call from an object to the Worker whole.
 *
 * **Ids.** On a server a conversation's id is the runtime's. On Cloudflare every object numbers its
 * own conversations from `1`, so the Worker's API names one `<conversation key>~<the object's id>`
 * (`qualify`), split on the last `~`. A client treats every id as opaque.
 */

import { APP_DESCRIPTION, type AppContext } from "@pikit/core";
import {
  ActorCallError,
  type AgentObserver,
  type AgentRuntime,
  type ConversationRef,
  type ConversationRegistry,
  type ObservedConversation,
  type PageRequest,
} from "@pikit/contracts";
import type { ApiAbortResponse, ApiApp, ApiConversation, ApiEvent, ApiPage, ApiResetResponse, ApiSendResponse, ApiTranscriptEntry, ApiUsage } from "./api.ts";

/** A message to a conversation, checked: what `POST …/messages` takes. */
export interface Message {
  text: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
}

/** What an action did, and to which key (for the operator's log line). */
export type Sent = ApiSendResponse & { key: string };
export type Aborted = ApiAbortResponse & { key: string };

export interface AdminBackend {
  /** The composition of the App that runs the agents. */
  app(ctx: AppContext): Promise<ApiApp>;
  /** Throws `invalid_cursor` for a cursor it did not give. */
  conversations(page: PageRequest, ctx: AppContext): Promise<ApiPage<ApiConversation>>;
  /** Throws `not_found`. */
  conversation(id: string, ctx: AppContext): Promise<ApiConversation>;
  /** Newest first. Throws `not_found`, `invalid_cursor`. */
  transcript(id: string, page: PageRequest, ctx: AppContext): Promise<ApiPage<ApiTranscriptEntry>>;
  /** What the conversation is now: the first event of its live events. Throws `not_found`. */
  snapshot(id: string, ctx: AppContext): Promise<ApiEvent>;
  /**
   * Its live events, a `snapshot` first, until `ctx` is cancelled or they end. Throws `not_found`
   * before the first one, so a route answers `404` rather than an empty stream.
   */
  live(id: string, ctx: AppContext): Promise<AsyncIterable<ApiEvent>>;
  /** Throws `not_found`. */
  usage(id: string, ctx: AppContext): Promise<ApiUsage>;
  /** The actions reach only a key's current conversation: they throw `not_found`, `no_agent`, `not_current`. */
  send(id: string, message: Message, ctx: AppContext): Promise<Sent>;
  abort(id: string, ctx: AppContext): Promise<Aborted>;
  reset(id: string, ctx: AppContext): Promise<ApiResetResponse>;
}

/** A refusal the routes answer with: `code` is the API's `error`. */
export function refusal(code: "not_found" | "no_agent" | "not_current" | "invalid_cursor" | "invalid_request", message: string): ActorCallError {
  return new ActorCallError(code, message);
}

export const NOT_FOUND = "no such conversation";

/** Splits a qualified id on its last `~`. */
const QUALIFIED = /^(.+)~([0-9]+)$/s;

/** The Worker's id of the object `key`'s conversation `local` (`telegram:1~2`). */
export function qualify(key: string, local: string): string {
  return `${key}~${local}`;
}

/** The key and the object's own id a qualified id names; `undefined` when it is not one. */
export function unqualify(id: string): { key: string; local: string } | undefined {
  const match = QUALIFIED.exec(id);
  return match === null ? undefined : { key: match[1] as string, local: match[2] as string };
}

export interface LocalContracts {
  observe(): AgentObserver;
  runtime(): AgentRuntime;
  registry(): ConversationRegistry;
}

/** The backend over the contracts of the App it runs in (a server's, or one Durable Object's). */
export function createLocalBackend(contracts: LocalContracts): AdminBackend {
  /** The conversation and whether its key points to it now. */
  const described = async (conversation: ObservedConversation, ctx: AppContext): Promise<ApiConversation> => {
    if (conversation.key === undefined) return conversation as ApiConversation;
    const now = await contracts.registry().get(conversation.key, ctx);
    return { ...(conversation as ApiConversation), current: now?.conversationId === conversation.conversationId };
  };

  const found = async (id: string, ctx: AppContext): Promise<ObservedConversation> => {
    const conversation = id === "" ? undefined : await contracts.observe().conversation(id, ctx);
    if (conversation === undefined) throw refusal("not_found", NOT_FOUND);
    return conversation;
  };

  /** The conversation as an action takes it, or why not: no message yet, or left behind by a reset. */
  const actionable = async (id: string, ctx: AppContext): Promise<ConversationRef> => {
    const conversation = await found(id, ctx);
    if (conversation.key === undefined || conversation.agent === undefined) {
      throw refusal("no_agent", "no message has reached this conversation yet: it has no agent to talk to");
    }
    const now = await contracts.registry().get(conversation.key, ctx);
    if (now?.conversationId !== conversation.conversationId) {
      throw refusal("not_current", "a reset left this conversation behind: its key points to another one");
    }
    return { key: conversation.key, agent: conversation.agent, conversationId: conversation.conversationId };
  };

  /** A read with the client's cursor: an observer refuses a cursor it did not give. */
  const paged = async <T>(page: PageRequest, read: () => Promise<T>): Promise<T> => {
    if (page.cursor === undefined) return read();
    try {
      return await read();
    } catch {
      throw refusal("invalid_cursor", "the cursor is not one this API gave");
    }
  };

  const live = async (id: string, ctx: AppContext): Promise<AsyncIterable<ApiEvent>> => {
    // `watch` rejects an unknown conversation only once read: ask first.
    await found(id, ctx);
    return contracts.observe().watch(id, ctx);
  };

  return {
    app: async (ctx) => ctx.value(APP_DESCRIPTION) as unknown as ApiApp,

    async conversations(page, ctx) {
      const result = await paged(page, () => contracts.observe().conversations(page, ctx));
      const items = await Promise.all(result.items.map((each) => described(each, ctx)));
      return { items, ...(result.next !== undefined && { next: result.next }) };
    },

    conversation: async (id, ctx) => described(await found(id, ctx), ctx),

    async transcript(id, page, ctx) {
      const result = id === "" ? undefined : await paged(page, () => contracts.observe().transcript(id, page, ctx));
      if (result === undefined) throw refusal("not_found", NOT_FOUND);
      return result as ApiPage<ApiTranscriptEntry>;
    },

    async snapshot(id, ctx) {
      const iterator = (await live(id, ctx))[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done === true) throw refusal("not_found", NOT_FOUND);
        return first.value;
      } finally {
        await iterator.return?.();
      }
    },

    live,

    async usage(id, ctx) {
      const usage = id === "" ? undefined : await contracts.observe().usage(id, ctx);
      if (usage === undefined) throw refusal("not_found", NOT_FOUND);
      return usage as ApiUsage;
    },

    async send(id, message, ctx) {
      const conversation = await actionable(id, ctx);
      const admission = await contracts.runtime().dispatch({ requestId: message.requestId, conversation, prompt: message.text, whenBusy: message.whenBusy }, ctx);
      return { key: conversation.key, requestId: message.requestId, admission: admission.kind };
    },

    async abort(id, ctx) {
      const conversation = await actionable(id, ctx);
      await contracts.runtime().abort(conversation, ctx);
      return { key: conversation.key, conversationId: conversation.conversationId };
    },

    async reset(id, ctx) {
      const conversation = await actionable(id, ctx);
      const reset = await contracts.registry().reset(conversation.key, ctx);
      if (reset === undefined) throw refusal("not_found", NOT_FOUND);
      return { key: conversation.key, previousConversationId: reset.previousConversationId, conversationId: reset.newConversationId };
    },
  };
}
