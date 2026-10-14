/**
 * A conversation's live view for its user (`GET /chat/api/conversations/:id/events`): `ChatEvent`s,
 * a projection of `agent.observe`'s `watch` of the key's current runtime conversation, with what the
 * store hears (`store.ts`'s `notify`), made in the App that holds the conversation.
 *
 * What the user sees, and only that:
 * - `state`: whether a run goes. The first event, then on each change.
 * - `partial`: the answer as written, its text only (no thinking, no tool calls), the whole text so
 *   far; `""` when a new one starts.
 * - `tool`: a tool's name while it runs (`running`), and when it ends (`done`): no arguments, no output.
 * - `message`: a message or an answer was stored, or a message's state changed: read them again.
 *
 * `partial` and `tool` come only during a run one of whose inputs is not an operator's (a request id
 * not `dashboard:`, as `startAnswerDelivery` decides what to deliver), known from the watch's own
 * `submission` events; for a run whose inputs it did not see (it was going when the view opened),
 * while the user has a message not answered yet (`store.pending`). A run the operator's own follow-up
 * started streams nothing to the user, and a fast run is streamed even when its user's message was
 * stored after it ended. Never a transcript entry, a system prompt, a tool's arguments or results, or an
 * operator's note.
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import { type AgentObserver, DASHBOARD_REQUEST_PREFIX, type ObservedEvent } from "@pikit/contracts";
import type { ChatEvent } from "./api.ts";
import type { ChatStore, StoreNote } from "./store.ts";

type Item = { kind: "observed"; event: ObservedEvent } | { kind: "note"; note: StoreNote } | { kind: "end"; error?: unknown };

type Block = { type?: unknown; text?: unknown };
type Assistant = { role?: unknown; content?: unknown };

/** The text blocks of an assistant message, joined: what the user reads of it. */
function textOf(message: Assistant | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return "";
  return (message.content as Block[]).flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");
}

/** pi-ai's streaming changes, applied to the text blocks only. */
function applyChanges(message: Assistant | undefined, changes: unknown): Assistant | undefined {
  if (!Array.isArray(changes)) return message;
  let current = message;
  for (const change of changes as { type?: unknown; contentIndex?: unknown; delta?: unknown; block?: unknown; message?: unknown }[]) {
    if (change?.type === "message") {
      current = change.message as Assistant;
      continue;
    }
    if (current === undefined || typeof change?.contentIndex !== "number") continue;
    const content = Array.isArray(current.content) ? [...(current.content as Block[])] : [];
    if (change.type === "text_delta" && typeof change.delta === "string") {
      const part = content[change.contentIndex];
      if (part?.type === "text") content[change.contentIndex] = { ...part, text: `${typeof part.text === "string" ? part.text : ""}${change.delta}` };
    } else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") {
      content[change.contentIndex] = change.block as Block;
    } else continue;
    current = { ...current, content };
  }
  return current;
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
 * stops reading (which releases the watch). A failing watch ends it with that error.
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

  let busy: boolean | undefined;
  let pending = await store.pending(key);
  /** The request id of each submission the watch reported, by its id: what a run's inputs are. */
  const requests = new Map<number, string>();
  /** Whether the run going is the user's, by its inputs; `undefined` when they are not all known (then `pending`). */
  let usersRun: boolean | undefined;
  const runOf = (inputs: unknown): boolean | undefined => {
    if (!Array.isArray(inputs) || inputs.length === 0) return undefined;
    const ids = inputs.map((input) => (typeof input === "number" ? requests.get(input) : undefined));
    if (ids.some((id) => id === undefined)) return undefined;
    return ids.some((id) => !(id as string).startsWith(DASHBOARD_REQUEST_PREFIX));
  };
  const streams = (): boolean => usersRun ?? pending;
  let partial: Assistant | undefined;
  let shown: string | undefined;
  const tools = new Map<string, string>();

  /** What changed for the user since the last events: a state, a partial text, tools. */
  function* changes(next: { busy?: boolean; partial?: Assistant | undefined; started?: boolean }): Generator<ChatEvent> {
    if (next.busy !== undefined && next.busy !== busy) {
      busy = next.busy;
      yield { type: "state", busy };
    }
    if ("partial" in next) partial = next.partial;
    if (!streams()) return;
    const text = partial === undefined ? undefined : textOf(partial);
    if (text !== undefined && (text !== shown || next.started === true)) {
      shown = text;
      yield { type: "partial", text };
    }
    if (text === undefined) shown = undefined;
  }

  try {
    // No conversation in the runtime yet: nothing runs.
    if (conversationId === undefined) yield* changes({ busy: false });
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
        pending = await store.pending(key);
        yield { type: "message", id: item.note.id };
        continue;
      }
      const event = item.event;
      switch (event.type) {
        case "submission": {
          const record = event.record as { id?: unknown; requestId?: unknown } | null;
          if (typeof record?.id === "number" && typeof record.requestId === "string") requests.set(record.id, record.requestId);
          break;
        }
        case "snapshot": {
          const generation = event.generation as { message?: Assistant } | undefined;
          const running = Array.isArray(event.tools) ? (event.tools as { callId?: unknown; name?: unknown; status?: unknown }[]) : [];
          usersRun = runOf((event.run as { inputs?: unknown } | null | undefined)?.inputs);
          yield* changes({ busy: event.run !== undefined && event.run !== null, partial: generation?.message?.role === "assistant" ? generation.message : undefined });
          const now = new Map(running.filter((tool) => tool.status !== "done" && typeof tool.callId === "string" && typeof tool.name === "string").map((tool) => [tool.callId as string, tool.name as string]));
          for (const [callId, name] of tools) if (!now.has(callId) && streams()) yield { type: "tool", name, state: "done" };
          for (const [callId, name] of now) if (!tools.has(callId) && streams()) yield { type: "tool", name, state: "running" };
          tools.clear();
          for (const [callId, name] of now) tools.set(callId, name);
          break;
        }
        case "run_start":
          usersRun = runOf(event.inputs);
          yield* changes({ busy: true });
          break;
        case "run_end":
          yield* changes({ busy: false, partial: undefined });
          tools.clear();
          usersRun = undefined;
          if (Array.isArray(event.inputs)) for (const input of event.inputs) if (typeof input === "number") requests.delete(input);
          break;
        case "message_start": {
          const message = event.message as Assistant | undefined;
          if (message?.role === "assistant") yield* changes({ partial: message, started: true });
          break;
        }
        case "message_update":
          if (partial !== undefined) yield* changes({ partial: applyChanges(partial, event.changes) });
          break;
        case "message_end":
          yield* changes({ partial: undefined });
          break;
        case "tool_execution_start": {
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          tools.set(String(event.toolCallId), name);
          if (streams()) yield { type: "tool", name, state: "running" };
          break;
        }
        case "tool_execution_end": {
          const name = tools.get(String(event.toolCallId));
          tools.delete(String(event.toolCallId));
          if (name !== undefined && streams()) yield { type: "tool", name, state: "done" };
          break;
        }
        default:
          break;
      }
    }
  } finally {
    ctx.abortSignal?.removeEventListener("abort", onAbort);
    unsubscribe();
    stop.abort();
    await pumping;
  }
}
