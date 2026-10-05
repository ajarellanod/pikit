/**
 * The Worker's backend, on Cloudflare: each conversation lives in the Durable Object of its key, which
 * the Worker reaches only by `actor.mailbox.call` (JSON in, JSON out, no stream). Every route is a call
 * to that object (`calls.ts`), whose answers name its conversations by its own ids: here they are
 * qualified, `<key>~<id>` (`backend.ts`).
 *
 * - **The list** asks the index (`INDEX_KEY`, `conversation-index.ts`) for a page of keys, the most
 *   recently active first, then each key's object for its conversations (its current one and those a
 *   reset left behind). A page is at most `KEYS_PER_PAGE` keys whatever `limit` asks (each is a
 *   subrequest; Workers count them), and may hold more conversations than keys. An object that does
 *   not answer is left out of the page, and logged.
 * - **Live events are polled**: no call streams, so `live` asks the object for its `snapshot` every
 *   `pollMs` and yields it only when it changed, then ends after `polls` of them (the subrequests of
 *   one request are bounded). The dashboard reconnects to a stream that ended (`live.ts`). Between two
 *   snapshots it sees no text streaming, only where the run is each second.
 * - **The composition** is an object's App (the index object's: every object runs the same App), where
 *   the agents run.
 */

import type { AppContext } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import type { ApiApp, ApiConversation, ApiEvent, ApiPage, ApiResetResponse, ApiSendResponse, ApiTranscriptEntry, ApiUsage } from "./api.ts";
import { type AdminBackend, NOT_FOUND, qualify, refusal, unqualify } from "./backend.ts";
import { CALL } from "./calls.ts";
import { INDEX_KEY, type IndexPage } from "./conversation-index.ts";

/** Keys read in one page of the list: one call each, besides the index's. */
export const KEYS_PER_PAGE = 20;
/** How often a live view asks its object for a snapshot. */
export const POLL_MS = 1_000;
/** Snapshots asked per stream before it ends (and the client reconnects): well under a request's subrequests. */
export const POLLS = 40;

export interface RemoteOptions {
  pollMs?: number;
  polls?: number;
}

export function createRemoteBackend(mailbox: () => ActorMailbox, options: RemoteOptions = {}): AdminBackend {
  const pollMs = options.pollMs ?? POLL_MS;
  const polls = options.polls ?? POLLS;
  const call = async <T>(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<T> => (await mailbox().call(key, type, message, ctx)) as T;

  /** The key and the object's id `id` names: a malformed one is not found. */
  const target = (id: string): { key: string; local: string } => {
    const found = unqualify(id);
    if (found === undefined) throw refusal("not_found", NOT_FOUND);
    return found;
  };
  const qualified = (key: string, conversation: ApiConversation): ApiConversation => ({ ...conversation, conversationId: qualify(key, conversation.conversationId) });
  const snapshotOf = (key: string, local: string, ctx: AppContext) => call<ApiEvent>(key, CALL.snapshot, { conversationId: local }, ctx);

  return {
    app: (ctx) => call<ApiApp>(INDEX_KEY, CALL.app, null, ctx),

    async conversations(page, ctx) {
      const limit = Math.min(page.limit ?? KEYS_PER_PAGE, KEYS_PER_PAGE);
      const keys = await call<IndexPage>(INDEX_KEY, CALL.list, { limit, ...(page.cursor !== undefined && { cursor: page.cursor }) }, ctx);
      const groups = await Promise.all(
        keys.items.map(async ({ key }) => {
          try {
            return (await call<ApiConversation[]>(key, CALL.conversations, null, ctx)).map((each) => qualified(key, each));
          } catch (error) {
            ctx.logger.warn("admin-api: a conversation's object did not answer; it is left out of the list", {
              conversation: key,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        }),
      );
      return { items: groups.flat(), ...(keys.next !== undefined && { next: keys.next }) };
    },

    async conversation(id, ctx) {
      const { key, local } = target(id);
      return qualified(key, await call<ApiConversation>(key, CALL.conversation, { conversationId: local }, ctx));
    },

    async transcript(id, page, ctx) {
      const { key, local } = target(id);
      return call<ApiPage<ApiTranscriptEntry>>(key, CALL.transcript, { conversationId: local, ...page }, ctx);
    },

    async snapshot(id, ctx) {
      const { key, local } = target(id);
      return snapshotOf(key, local, ctx);
    },

    async live(id, ctx) {
      const { key, local } = target(id);
      // Asked before the stream starts: an unknown conversation is a 404, not an empty stream.
      const first = await snapshotOf(key, local, ctx);
      return polled(first, () => snapshotOf(key, local, ctx), pollMs, polls, ctx.abortSignal);
    },

    async usage(id, ctx) {
      const { key, local } = target(id);
      return call<ApiUsage>(key, CALL.usage, { conversationId: local }, ctx);
    },

    async send(id, message, ctx) {
      const { key, local } = target(id);
      const sent = await call<ApiSendResponse>(key, CALL.message, { conversationId: local, ...message }, ctx);
      return { key, requestId: sent.requestId, admission: sent.admission };
    },

    async abort(id, ctx) {
      const { key, local } = target(id);
      await call<JsonValue>(key, CALL.abort, { conversationId: local }, ctx);
      return { key, conversationId: id };
    },

    async reset(id, ctx) {
      const { key, local } = target(id);
      const reset = await call<ApiResetResponse>(key, CALL.reset, { conversationId: local }, ctx);
      return { key: reset.key, previousConversationId: qualify(key, reset.previousConversationId), conversationId: qualify(key, reset.conversationId) };
    },
  };
}

/**
 * `first`, then what `next` answers every `pollMs` when it differs from the last one yielded, `polls`
 * answers in all (`first` among them). Ends early when `signal` aborts.
 */
export async function* polled(first: ApiEvent, next: () => Promise<ApiEvent>, pollMs: number, polls: number, signal: AbortSignal | undefined): AsyncGenerator<ApiEvent> {
  let last = JSON.stringify(first);
  yield first;
  for (let asked = 1; asked < polls; asked++) {
    if (!(await sleep(pollMs, signal))) return;
    const event = await next();
    const text = JSON.stringify(event);
    if (text === last) continue;
    last = text;
    yield event;
  }
}

/** Waits `ms`; `false` when `signal` aborted first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
