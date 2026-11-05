/**
 * `agent.observe` on pi-durable (@pikit/contracts' observe.ts): what an operator sees of the runtime,
 * read from pi-durable's own records through the runtime's open Harness (`DurableRuntime.opened`),
 * never a copy. Nothing here commits.
 *
 * | contract        | pi-durable |
 * |-----------------|------------|
 * | `conversations` | `Storage.scanConversations`, ascending ids (creation order); conversations a task owns (subagents) are left out |
 * | `key`, `agent`  | pikit's `pikit.conversation` document, written when a message first reaches the conversation |
 * | `busy`          | `pi.live`'s `run`, present exactly while a run goes |
 * | `lastActivity`  | the newest message's `timestamp` |
 * | `usage`         | `pi.usage`: every model call and tool, summed (pi-ai's `Usage`) |
 * | `transcript`    | `Conversation.entries`, newest first; an entry's `model` messages are pi-ai's `Message`s |
 * | `watch`         | `Conversation.watch` (the view, spec §9.3): `pi.live` projected as `ObservedLive` and diffed, the window's new entries, `pi.usage` changing; a slow consumer gets the values folded |
 *
 * Neutral: on a server it sees every conversation of the storage; in a Cloudflare Durable Object, the
 * object's own (features/cloudflare-conversation-index.md).
 */

import type { Context as ChordContext, WatchEnd } from "@earendil-works/chord";
import {
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type Harness,
  LiveDoc,
  type LiveState,
  type Storage,
  type SubmissionId,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { AppContext } from "@pikit/core";
import { type AgentObserver, diffOps, type JsonValue, type ObservedConversation, type ObservedEvent, type ObservedLive, type Page, type PageRequest, type TranscriptEntry, type Usage } from "@pikit/contracts";
import { ConversationDoc } from "./agent.ts";
import { toChord } from "./context.ts";
import { durableId } from "./submissions.ts";

/** What the observer reads: the runtime's open Harness and its storage. */
export interface ObservedRuntime {
  opened(ctx: AppContext): Promise<{ harness: Harness; storage: Storage }>;
}

/** A page's size when the caller does not say. */
export const OBSERVE_PAGE = 50;
/** The largest page a caller may ask for. */
export const OBSERVE_MAX_PAGE = 500;

/** `agent.observe` over the runtime `current()` returns (it throws while the app is not running). */
export function createObserver(current: () => ObservedRuntime): AgentObserver {
  const open = (ctx: AppContext) => current().opened(ctx);

  const summary = async (harness: Harness, id: ConversationId, chord: ChordContext): Promise<ObservedConversation | undefined> => {
    const conversation = await harness.conversation(id, chord);
    if (conversation === undefined) return undefined;
    const [recorded, live, usage, newest] = await Promise.all([
      harness.snapshot(ConversationDoc, id, chord),
      harness.snapshot(LiveDoc, id, chord),
      harness.snapshot(UsageDoc, id, chord),
      conversation.entries({}, 8, undefined, chord),
    ]);
    const lastActivity = newest.items.flatMap((entry) => (entry.model ?? []).map((message) => message.timestamp)).find((at) => typeof at === "number");
    return {
      conversationId: String(id),
      ...(recorded !== undefined && { key: recorded.key, agent: recorded.agent }),
      busy: live?.run !== undefined,
      ...(lastActivity !== undefined && { lastActivity }),
      usage: total(usage),
    };
  };

  return {
    async conversations(page, ctx) {
      const { harness, storage } = await open(ctx);
      const chord = toChord(ctx);
      const scanned = await storage.scanConversations({}, limitOf(page), cursorOf(page), chord);
      const items: ObservedConversation[] = [];
      for (const record of scanned.items) {
        // A subagent's conversation belongs to the task that made it, not to an operator's list.
        if (record.owner !== undefined) continue;
        const found = await summary(harness, record.id, chord);
        if (found !== undefined) items.push(found);
      }
      return pageOf(items, scanned.next);
    },

    async conversation(conversationId, ctx) {
      const id = durableId(conversationId);
      if (id === undefined) return undefined;
      const { harness } = await open(ctx);
      return summary(harness, id, toChord(ctx));
    },

    async transcript(conversationId, page, ctx) {
      const id = durableId(conversationId);
      if (id === undefined) return undefined;
      const { harness } = await open(ctx);
      const chord = toChord(ctx);
      const conversation = await harness.conversation(id, chord);
      if (conversation === undefined) return undefined;
      const entries = await conversation.entries({}, limitOf(page), cursorOf(page), chord);
      const items: TranscriptEntry[] = entries.items.map(entryOf);
      return pageOf(items, entries.next);
    },

    watch(conversationId, ctx) {
      return follow(open, conversationId, ctx);
    },

    async usage(conversationId, ctx) {
      const id = durableId(conversationId);
      if (id === undefined) return undefined;
      const { harness } = await open(ctx);
      const chord = toChord(ctx);
      if ((await harness.conversation(id, chord)) === undefined) return undefined;
      return total(await harness.snapshot(UsageDoc, id, chord));
    },
  };
}

/**
 * One conversation live, from `Conversation.watch` (its view: a window over the transcript and the
 * `pi.*` documents), until `ctx` is cancelled or the watch ends. Each value the watch delivers is
 * held until the consumer has taken every event made of it, so a consumer that falls behind makes
 * pi-durable fold the values meanwhile into the newest one: memory stays one value and its events.
 */
async function* follow(open: (ctx: AppContext) => Promise<{ harness: Harness }>, conversationId: string, ctx: AppContext): AsyncGenerator<ObservedEvent> {
  const id = durableId(conversationId);
  const { harness } = await open(ctx);
  const chord = toChord(ctx);
  const conversation = id === undefined ? undefined : await harness.conversation(id, chord);
  if (conversation === undefined) throw new Error(`agent.observe: no conversation ${JSON.stringify(conversationId)}`);
  // Cancelling `ctx` ends the watch (`aborted`).
  const watch = await conversation.watch(chord);
  const first = watch.value;

  /** The newest value delivered and not yet taken, with what releases pi-durable's watch. */
  let pending: { view: ConversationView; taken(): void } | undefined;
  let ended: WatchEnd | undefined;
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  watch.start(async (call) => {
    // pi-durable never sends `failed` calls: its failures end the watch.
    if (call.kind !== "value") return;
    await new Promise<void>((taken) => {
      pending = { view: call.value, taken };
      signal();
    });
  });
  void watch.closed.then((end) => ((ended ??= end), signal()));
  const cancelled = ctx.abortSignal;
  const onAbort = () => ((ended ??= { kind: "aborted" }), signal());
  cancelled?.addEventListener("abort", onAbort, { once: true });

  const live = liveOf(harness, chord);
  try {
    let shown = await live(first);
    yield { type: "live", ops: [["r", shown as unknown as JsonValue]] };
    let last = first.entries.at(-1)?.id ?? first.before;
    let usage = first.docs["pi.usage"];
    for (;;) {
      if (cancelled?.aborted === true) return;
      const next = pending;
      if (next === undefined) {
        if (ended !== undefined) break;
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      pending = undefined;
      try {
        const { view } = next;
        // Entry ids ascend in the window: what is past the newest one sent is new.
        const from = view.entries.findIndex((entry) => last === undefined || entry.id > last);
        if (from !== -1) {
          // The entry the window has before the new ones is the newest one sent, unless some went past unsent.
          const continues = (from > 0 ? view.entries[from - 1]?.id : view.before) === last;
          last = view.entries.at(-1)?.id;
          yield { type: "entries", entries: view.entries.slice(from).map(entryOf) };
          if (!continues) yield { type: "transcript" };
        }
        // pi-durable applies documents immutably: an unchanged one is the same object.
        if (view.docs["pi.usage"] !== usage) {
          usage = view.docs["pi.usage"];
          yield { type: "usage" };
        }
        const now = await live(view);
        const ops = diffOps(shown as unknown as JsonValue, now as unknown as JsonValue);
        shown = now;
        if (ops.length > 0) yield { type: "live", ops };
      } finally {
        next.taken();
      }
    }
    if (ended?.kind === "failed" || ended?.kind === "listener_error") throw ended.error;
  } finally {
    cancelled?.removeEventListener("abort", onAbort);
    pending?.taken();
    await watch.stop().catch(() => {});
  }
}

/**
 * What a view shows live (`pi.live`), as the contract's `ObservedLive`. A run's inputs are
 * submissions: their request ids are read once each, and kept while the run lists them.
 */
function liveOf(harness: Harness, chord: ChordContext): (view: ConversationView) => Promise<ObservedLive> {
  let known = new Map<SubmissionId, string | undefined>();
  const requestOf = async (submission: SubmissionId): Promise<string | undefined> => {
    if (known.has(submission)) return known.get(submission);
    const record = await (await harness.submission(submission, chord))?.status(chord);
    return record?.requestId;
  };
  return async (view) => {
    const state = view.docs["pi.live"] as LiveState | undefined;
    const run = state?.run;
    let requests: string[] | undefined;
    if (run !== undefined) {
      const next = new Map<SubmissionId, string | undefined>();
      for (const submission of run.inputs) next.set(submission, await requestOf(submission));
      known = next;
      requests = [...next.values()].filter((requestId) => requestId !== undefined);
    }
    const message = state?.generation?.message;
    const failure = state?.runFailure;
    return {
      busy: run !== undefined,
      ...(requests !== undefined && { requests }),
      ...(message !== undefined && { partial: message as unknown as JsonValue }),
      tools: (state?.tools ?? []).map((slot) => ({ callId: slot.callId, name: slot.name, status: slot.status, ...(slot.output !== undefined && { output: slot.output }) })),
      ...(failure !== undefined && { failure: { reason: failure.reason, ...(failure.detail !== undefined && { detail: failure.detail }) } }),
    };
  };
}

/** A transcript entry as the contract carries it. */
function entryOf(entry: EntryRecord): TranscriptEntry {
  return { id: String(entry.id), kind: entry.kind, messages: json(entry.model ?? []) };
}

/** A pi-durable value as plain JSON: what the contract carries (no `undefined`, no class). */
function json<T>(value: T): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

/** Every bucket of `pi.usage` summed: what the conversation cost. */
function total(state: Readonly<UsageState> | undefined): Usage {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})]) {
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
    sum.totalTokens += usage.totalTokens;
    sum.cost.input += usage.cost.input;
    sum.cost.output += usage.cost.output;
    sum.cost.cacheRead += usage.cost.cacheRead;
    sum.cost.cacheWrite += usage.cost.cacheWrite;
    sum.cost.total += usage.cost.total;
  }
  return sum as Usage;
}

function limitOf(page: PageRequest): number {
  const limit = page.limit ?? OBSERVE_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`agent.observe: a page's limit is a positive integer, not ${limit}`);
  return Math.min(limit, OBSERVE_MAX_PAGE);
}

/** pi-durable's cursor (a JSON object) travels as the contract's string. */
function cursorOf(page: PageRequest): Readonly<Record<string, never>> | undefined {
  if (page.cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(page.cursor);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Readonly<Record<string, never>>;
  } catch {
    // Reported below.
  }
  throw new Error("agent.observe: the cursor is not one this observer gave");
}

function pageOf<T>(items: T[], next: object | undefined): Page<T> {
  return next === undefined ? { items } : { items, next: JSON.stringify(next) };
}
