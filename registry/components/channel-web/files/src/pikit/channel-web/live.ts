/**
 * A conversation's live view for its user (`GET /chat/api/conversations/:id/events`): `ChatEvent`s
 * (api.ts), a projection of `agent.observe`'s `watch` of the key's current runtime conversation and of
 * what the store hears (`store.ts`'s `notify`), made in the App that holds the conversation. What users
 * may see of it is cut later, by the operator's policy (`visibility.ts`, in the routes); here, which
 * runs and entries are the user's at all, and only those.
 *
 * - `live`: the user's `ChatLive`, the watch's `ObservedLive` projected (`userLive`), sent whole first
 *   (`["r", value]`) and then as the ops between one projection and the next (`diffOps`): whether a run
 *   goes (any run); the answer being written, the tools and why the run ended without an answer only
 *   for a run of the user's. The answer is the runtime's message as it is (the routes cut it); the tools
 *   their call id, name, status and output, nothing else of the runtime's.
 * - `entries`: a user's message now in the transcript (the store's `entry` note, `userEntryOf`); the
 *   messages a run of the user's wrote, each an entry of its own with the transcript's id
 *   (`runEntryId`), never the user's message as the runtime holds it (with what a stage added), nor an
 *   operator's, nor a system prompt (`runMessages`). The runtime's own entries of any other run never.
 * - `transcript`: the store says something stored changed (its `changed` note). The runtime's own
 *   `transcript` and `usage` hints never: the chat's transcript is the store's, and usage is not shown.
 *
 * **Whose run.** A run is the user's when its requests (`ObservedLive.requests`, the request ids of its
 * inputs) include one of the user's messages (a `web:` request id: this conversation's key is the
 * user's). A run that answers both a user's message and an operator's follow-up is the user's, as its
 * messages are stored for them. It fails closed: a run with no request of the user's (an operator's, a
 * continue) shows nothing but that it goes, and a failure the view did not see the run of (it opened
 * after the run ended) is not shown.
 *
 * Changes the watch sends in a row while the reader is behind are folded into one `live` event (never
 * past an `entries` event, which goes before the change that ends the answer it holds).
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import { type AgentObserver, applyOps, diffOps, type JsonOp, type JsonValue, type ObservedEvent, type ObservedLive } from "@pikit/contracts";
import { CHAT_REQUEST_PREFIX, type ChatEvent, type ChatLive, type ChatTranscriptEntry } from "./api.ts";
import { runEntryId, runMessages } from "./entries.ts";
import type { ChatStore, StoreNote } from "./store.ts";

type Item = { kind: "observed"; event: ObservedEvent } | { kind: "note"; note: StoreNote } | { kind: "end"; error?: unknown };

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {});

/** What a conversation with no runtime conversation yet shows: nothing runs. */
const IDLE: ChatLive = { busy: false, tools: [] };

/** Whether a run of `requests` is the user's: one of them is a message of the user's. */
const answersUser = (requests: readonly string[] | undefined): boolean => requests?.some((id) => id.startsWith(CHAT_REQUEST_PREFIX)) === true;

/**
 * `observed` as its user sees it: `mine` says whether its run (going, or the last one this view saw
 * going) is the user's. Only the fields named here pass.
 */
export function userLive(observed: ObservedLive, mine: boolean): ChatLive {
  if (!mine) return { busy: observed.busy === true, tools: [] };
  const partial = fieldsOf(observed.partial);
  const tools = observed.busy === true && Array.isArray(observed.tools) ? observed.tools : [];
  return {
    busy: observed.busy === true,
    ...(observed.busy === true && partial.role === "assistant" && { partial }),
    tools: tools.map((tool) => ({ callId: tool.callId, name: tool.name, status: tool.status, ...(typeof tool.output === "string" && { output: tool.output }) })),
    ...(observed.busy !== true && typeof observed.failure?.reason === "string" && { failure: { reason: observed.failure.reason } }),
  };
}

export interface LiveOptions {
  observe: AgentObserver;
  store: ChatStore;
  key: string;
  /** The key's current runtime conversation; `undefined` when it has none (nothing to watch but the store). */
  conversationId: string | undefined;
}

/**
 * The live events of `options.key` until `ctx` is cancelled, the runtime's watch ends, or the caller
 * stops reading (which releases the watch). A failing watch ends it with that error, and so does a
 * `live` event whose ops do not apply (the view reconnects, and starts from a whole value again).
 */
export async function* liveEvents(options: LiveOptions, ctx: AppContext): AsyncGenerator<ChatEvent> {
  const { observe, store, key, conversationId } = options;
  const stop = new AbortController();
  const watchCtx = ctx.derive((context) => withAbortSignal(stop.signal, context));
  const queue: Item[] = [];
  let wake: (() => void) | undefined;
  const push = (item: Item): void => {
    queue.push(item);
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const unsubscribe = store.subscribe(key, (note) => push({ kind: "note", note }));
  const onAbort = (): void => push({ kind: "end" });
  ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

  let pumping: Promise<void> | undefined;
  if (conversationId !== undefined) {
    const watched = observe.watch(conversationId, watchCtx)[Symbol.asyncIterator]();
    pumping = (async () => {
      try {
        for (;;) {
          const next = await watched.next();
          if (next.done === true) break;
          push({ kind: "observed", event: next.value });
        }
        push({ kind: "end" });
      } catch (error) {
        push({ kind: "end", ...(!stop.signal.aborted && { error }) });
      } finally {
        await watched.return?.().catch(() => {});
      }
    })();
  }

  /** The runtime's live value, as the watch's ops made it; `undefined` before its first `live`. */
  let observed: JsonValue | undefined;
  /** Whether the run going, or else the last one this view saw going, is the user's. */
  let mine = false;
  /** The user's live value last sent; `undefined` before the first. */
  let sent: ChatLive | undefined;

  /** The `live` event that brings the view from what was sent to `next`, if anything changed. */
  const liveEvent = (next: ChatLive): ChatEvent | undefined => {
    const ops = sent === undefined ? [["r", next as unknown as JsonValue] as const] : diffOps(sent as unknown as JsonValue, next as unknown as JsonValue);
    sent = next;
    return ops.length === 0 ? undefined : { type: "live", ops };
  };

  /** The run's messages `entries` hold, each an entry of its own with the transcript's id; none of a run not the user's. */
  const runEntriesOf = (entries: readonly { messages: readonly unknown[] }[]): ChatTranscriptEntry[] => {
    const live = observed as unknown as ObservedLive | undefined;
    const run = live?.requests?.[0];
    if (run === undefined || !answersUser(live?.requests)) return [];
    return entries.flatMap((entry) => runMessages(entry.messages).map((message): ChatTranscriptEntry => ({ id: runEntryId(run, message), kind: "message", messages: [message] })));
  };

  /**
   * The watch's `ops` applied. A run seen going names `mine`; a failure that changed while nothing was
   * seen going is a run's this view never saw: not the user's.
   */
  const heard = (ops: readonly JsonOp[]): void => {
    const before = observed as unknown as ObservedLive | undefined;
    observed = applyOps(observed ?? null, ops);
    const live = observed as unknown as ObservedLive;
    if (live.busy === true) mine = answersUser(live.requests);
    else if (before?.busy !== true && JSON.stringify(before?.failure) !== JSON.stringify(live.failure)) mine = false;
  };

  try {
    // No conversation in the runtime yet: nothing runs.
    if (conversationId === undefined) yield liveEvent(IDLE) as ChatEvent;
    for (;;) {
      if (ctx.abortSignal?.aborted === true) return;
      const item = queue.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      if (item.kind === "end") {
        if (item.error !== undefined) throw item.error;
        return;
      }
      if (item.kind === "note") {
        yield item.note.type === "entry" ? { type: "entries", entries: [item.note.entry] } : { type: "transcript" };
        continue;
      }
      const event = item.event;
      if (event.type === "entries") {
        const entries = runEntriesOf(event.entries);
        if (entries.length > 0) yield { type: "entries", entries };
        continue;
      }
      if (event.type !== "live") continue;
      // The changes queued right behind it, folded (never past another kind of item), each one read for whose run it is.
      heard(event.ops);
      for (let next = queue[0]; next?.kind === "observed" && next.event.type === "live"; next = queue[0]) {
        queue.shift();
        heard(next.event.ops);
      }
      const shown = liveEvent(userLive(observed as unknown as ObservedLive, mine));
      if (shown !== undefined) yield shown;
    }
  } finally {
    ctx.abortSignal?.removeEventListener("abort", onAbort);
    unsubscribe();
    stop.abort();
    await pumping;
  }
}
