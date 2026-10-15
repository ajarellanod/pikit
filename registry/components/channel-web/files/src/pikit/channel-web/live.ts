/**
 * A conversation's live view for its user (`GET /chat/api/conversations/:id/events`): the dashboard's
 * event shapes (`ChatEvent`, api.ts), a projection of `agent.observe`'s `watch` of the key's current
 * runtime conversation and of what the store hears (`store.ts`'s `notify`), made in the App that holds
 * the conversation. What users may see of what passes is cut later, by the operator's policy
 * (`visibility.ts`, in the routes); here, which runs and entries are the user's at all, and only those.
 *
 * - `snapshot` first: `run` (`{}`) while any run goes; the answer being written (`generation.message`)
 *   and the tools going (`tools`) only for a run of the user's.
 * - `run_start`, `run_end`: any run (only whether the assistant is busy).
 * - `message_start`, `message_update`, `message_end` (its `entry`), `tool_execution_*`: only during a run
 *   of the user's, and only the assistant's messages and the tools' results: never the user's message
 *   as the runtime holds it (with what a stage added), nor an operator's. `message_end`'s entry carries
 *   the id the transcript will have (`runEntryId`), one entry per message.
 * - `entry_appended`: with `entry`, a user's message now in the transcript (`userEntryOf`); without, the
 *   transcript changed (read it again). The runtime's own `entry_appended` (entries no model reads) never.
 *
 * **Whose run.** A run is the user's when its inputs are known to include one of the user's messages
 * (a `web:` request id: this conversation's key is the user's), known from the watch's own `submission`
 * events, which the runtime sends before the run that takes them starts. A run that answers both a
 * user's message and an operator's follow-up is the user's, as its messages are stored for them. A run
 * going when the view opened (a snapshot names its inputs by submission id only, and
 * `agent.submissions` cannot turn one into a request id) is named by the request that started it, which
 * this App heard (`agent.started`, kept by the store until the run ends). It fails closed: a run it
 * cannot name (its start not heard: the process restarted) streams nothing, its messages come with the
 * transcript once stored; the next run that starts is named. So a run the operator's own follow-up
 * started never streams to the user, even while the user's message waits.
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import type { AgentObserver, ObservedEvent } from "@pikit/contracts";
import { CHAT_REQUEST_PREFIX, type ChatEvent } from "./api.ts";
import { liveEntryOf, runEntryId, runMessages } from "./entries.ts";
import type { ChatStore, StoreNote } from "./store.ts";

type Item = { kind: "observed"; event: ObservedEvent } | { kind: "note"; note: StoreNote } | { kind: "end"; error?: unknown };

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {});
const pick = (from: Fields, keys: readonly string[]): Fields => Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

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

  /** The request id of each submission the watch reported, by its id: what a run's inputs are. */
  const requests = new Map<number, string>();
  /** The request ids of the run going, by its inputs; `undefined` when they are not all known. */
  let runRequests: string[] | undefined;
  const requestsOf = (inputs: unknown): string[] | undefined => {
    if (!Array.isArray(inputs) || inputs.length === 0) return undefined;
    const ids = inputs.map((input) => (typeof input === "number" ? requests.get(input) : undefined));
    return ids.some((id) => id === undefined) ? undefined : (ids as string[]);
  };
  /** Whether the run going is the user's: its inputs are known, and one of them is a message of the user's. Unknown inputs: no. */
  const streams = (): boolean => runRequests?.some((id) => id.startsWith(CHAT_REQUEST_PREFIX)) === true;

  /** The run's messages an entry holds, each an entry of its own with the transcript's id. */
  const entriesOf = (value: unknown): Fields[] => {
    const run = runRequests?.[0];
    const model = fieldsOf(value).model;
    if (run === undefined || !Array.isArray(model)) return [];
    return runMessages(model).map((message) => ({ id: runEntryId(run, message), kind: "message", model: [message] }));
  };

  try {
    // No conversation in the runtime yet: nothing runs.
    if (conversationId === undefined) yield { type: "snapshot", tools: [] };
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
        yield item.note.type === "entry" ? { type: "entry_appended", entry: liveEntryOf(item.note.entry) } : { type: "entry_appended" };
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
          const run = event.run as { inputs?: unknown } | null | undefined;
          const going = run !== undefined && run !== null;
          // A snapshot names its run's inputs by submission id: the request that started it, as this App
          // heard it (`agent.started`), names it when the watch has not.
          const starter = !going || conversationId === undefined ? undefined : store.startedBy(conversationId);
          runRequests = going ? (requestsOf(run.inputs) ?? (starter === undefined ? undefined : [starter])) : undefined;
          const message = fieldsOf(fieldsOf(event.generation).message);
          const mine = streams();
          yield {
            type: "snapshot",
            ...(going && { run: {} }),
            ...(mine && message.role === "assistant" && { generation: { message } }),
            tools: mine && Array.isArray(event.tools) ? event.tools.map((tool) => pick(fieldsOf(tool), ["callId", "name", "status", "output"])) : [],
          };
          break;
        }
        case "run_start":
          runRequests = requestsOf(event.inputs);
          yield { type: "run_start" };
          break;
        case "run_end":
          runRequests = undefined;
          if (Array.isArray(event.inputs)) for (const input of event.inputs) if (typeof input === "number") requests.delete(input);
          yield { type: "run_end" };
          break;
        case "message_start": {
          const message = fieldsOf(event.message);
          if (streams() && message.role === "assistant") yield { type: "message_start", message };
          break;
        }
        case "message_update":
          if (streams()) yield { type: "message_update", changes: event.changes };
          break;
        case "message_end": {
          if (!streams()) break;
          const [first, ...more] = entriesOf(event.entry);
          yield { type: "message_end", ...(first !== undefined && { entry: first }) };
          for (const entry of more) yield { type: "entry_appended", entry };
          break;
        }
        case "tool_execution_start":
          if (streams()) yield { type: event.type, ...pick(event, ["toolCallId", "toolName", "args"]) };
          break;
        case "tool_execution_update":
          if (streams()) yield { type: event.type, ...pick(event, ["toolCallId", "toolName", "output"]) };
          break;
        case "tool_execution_end":
          if (streams()) yield { type: event.type, ...pick(event, ["toolCallId", "toolName"]) };
          break;
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
