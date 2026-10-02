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
 * | `watch`         | `watchEvents` (pi-durable's agent events, spec §9.4): a `snapshot`, then a batch per commit; one that falls behind is sent a new `snapshot` |
 *
 * Neutral: on a server it sees every conversation of the storage; in a Cloudflare Durable Object, the
 * object's own (features/cloudflare-conversation-index.md).
 */

import type { Context as ChordContext } from "@earendil-works/chord";
import { type AgentEvent, type ConversationId, type Harness, LiveDoc, type Storage, UsageDoc, type UsageState, watchEvents } from "@earendil-works/pi-durable";
import type { AppContext } from "@pikit/core";
import type { AgentObserver, ObservedConversation, ObservedEvent, ObservedPage, PageRequest, TranscriptEntry, Usage } from "@pikit/contracts";
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
      const items: TranscriptEntry[] = entries.items.map((entry) => ({ id: String(entry.id), kind: entry.kind, messages: json(entry.model ?? []) }));
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

/** One conversation's events, from `watchEvents`, until `ctx` is cancelled or the stream ends. */
async function* follow(open: (ctx: AppContext) => Promise<{ harness: Harness }>, conversationId: string, ctx: AppContext): AsyncGenerator<ObservedEvent> {
  const id = durableId(conversationId);
  const { harness } = await open(ctx);
  const chord = toChord(ctx);
  if (id === undefined || (await harness.conversation(id, chord)) === undefined) throw new Error(`agent.observe: no conversation ${JSON.stringify(conversationId)}`);
  const stream = await watchEvents(harness, id, chord);

  /** Batches delivered and not yet taken, each with what tells pi-durable it was taken. */
  const batches: { events: readonly AgentEvent[]; taken(): void }[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  // The listener resolves once its batch is taken, so a slow consumer makes pi-durable hold its
  // batches, and past its bound replace them with one snapshot: memory stays bounded.
  stream.start((events) => new Promise<void>((taken) => (batches.push({ events, taken }), signal())));
  void stream.closed.then(() => ((ended = true), signal()));
  const cancelled = ctx.abortSignal;
  const onAbort = () => ((ended = true), signal());
  cancelled?.addEventListener("abort", onAbort, { once: true });

  try {
    yield event(stream.snapshot);
    for (;;) {
      if (cancelled?.aborted === true) return;
      const batch = batches.shift();
      if (batch !== undefined) {
        batch.taken();
        for (const each of batch.events) yield event(each);
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    cancelled?.removeEventListener("abort", onAbort);
    for (const batch of batches.splice(0)) batch.taken();
    await stream.stop().catch(() => {});
  }
}

/** A pi-durable value as plain JSON: what the contract carries (no `undefined`, no class). */
function json<T>(value: T): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

function event(value: AgentEvent): ObservedEvent {
  return json(value);
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

function pageOf<T>(items: T[], next: object | undefined): ObservedPage<T> {
  return next === undefined ? { items } : { items, next: JSON.stringify(next) };
}
