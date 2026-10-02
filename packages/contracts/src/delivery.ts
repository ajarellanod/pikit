/**
 * Answer delivery: the outbound counterpart of `admitInbound`. A chat channel calls
 * `startAnswerDelivery` in its `start` and gets durable, at-least-once delivery of every run's answer
 * to its platform; it supplies only what is its platform's:
 *
 * - `route(conversationKey)`: which of its instances (`telegram`, `telegram:ops`) a conversation
 *   belongs to, or `undefined` for another channel's;
 * - `transports`: each instance's `ChannelTransport` (split, send one piece with its key, classify a
 *   failure into a `DeliveryError`);
 * - `text(answer)`: what the user is told about a run, in the channel's words, or nothing;
 * - `policy`: its waits and budgets, as values in its own source (nothing here chooses them).
 *
 * What it gets, the same on every target:
 * - **Answers from `agent.submissions`' `answers` feed** (SPEC K3), from a cursor the channel keeps in
 *   its namespace of `storage.kv` (`answers-cursor`; absent, the feed's oldest answer). An answer that
 *   ended while the channel was stopped, whose event was lost, or whose delivery failed, is delivered
 *   when it reads again: at start, at every `wake` (the channel calls it on `agent.settled` /
 *   `agent.failed`), and when a retry comes due.
 * - **One lane per conversation.** A conversation's answers go in the feed's order; one whose answer
 *   cannot be delivered holds up only itself, up to `policy.window` answers read past the oldest one
 *   not delivered. Lanes run at the same time.
 * - **Retries.** A failed answer is tried again after `policy.retryMs` (the last repeats), or after
 *   what the platform asked (`rate_limited`), and logged as an error from `policy.blockedAfter`
 *   failures in a row. A `permanent` refusal is logged and given up: retrying would fail the same way.
 * - **Idempotency keys.** An answer's key is `answerKey(conversation, requestId)`; its pieces are
 *   `${key}#${index}`, the same on every retry and after any restart.
 * - **Both runtime models.** With `wakeups` (a Durable Object: nothing runs between events), every
 *   run is a wakeup: it stops at its context's slice deadline or after `policy.piecesPerRun` sends, and
 *   asks for the next one. Without (a server: a process that stays up), the same runs are driven by a
 *   timer in this process. Nothing is kept in memory that a crash would lose but a retry's wait.
 *
 * **What survives a crash, step by step.** No transaction spans the queue, the platform and the
 * cursor (a platform has none, and `outbound.queue` is another component's storage), so each step is
 * idempotent and the writes are ordered so that a crash between two of them repeats only an
 * idempotent step:
 * 1. With `outbound.queue`: `enqueue` under the answer's key (enqueued twice, stored once). Without:
 *    each piece is marked `sending` in `storage.kv`, sent, then marked `sent`; a piece found `sending`
 *    may have reached the platform and is sent again with `possibleDuplicate` and the same key (an
 *    idempotent transport passes the key, the platform drops the copy; another marks it). A piece
 *    marked `sent` is never sent again.
 * 2. The answer is marked done (`answer:<key>`): an answer delivered past a stuck one is not
 *    delivered again by the next run, nor after a restart.
 * 3. The cursor moves past the answers delivered in a row from it, then their marks are deleted.
 *
 * So the at-least-once window is exactly: a piece whose send was cut (a crash, a stop, a slice's
 * deadline, a timeout) goes again once, marked, with its key; everything else is sent once. A crash
 * between 3's save and its deletes leaves a few marks behind, never a second send. Delivering through
 * the queue, a crash between 1 and 2 enqueues again, which the queue absorbs.
 *
 * Pi first: delivery to a chat platform is pikit's (P1); the feed is runtime-pi's record of pi-durable.
 */

import { type AppContext, BACKGROUND_CONTEXT } from "@pikit/core";
import type { Feed, FeedItem } from "./feed.ts";
import { answerKey, type ChannelTransport, DeliveryError, type OutboundQueue } from "./outbound.ts";
import type { KeyValueStore } from "./storage.ts";
import type { RunSettlement } from "./submissions.ts";
import type { Wakeups } from "./wakeups.ts";

/** The channel's waits and budgets: its policy, kept in its own source. */
export interface DeliveryPolicy {
  /** How long to wait after the 1st, 2nd, 3rd… failure in a row of an answer (or of a read); the last repeats. */
  retryMs: readonly number[];
  /** From this failure in a row on, an answer that cannot be delivered is logged as an error. */
  blockedAfter: number;
  /** How many answers a run reads past the oldest one not delivered: how far the other conversations may get meanwhile. */
  window: number;
  /** Pieces one run sends at most; then it asks for the next run at once (a Durable Object's subrequests, C4). */
  piecesPerRun: number;
  /** How long one piece's send may take before it counts as cut (it may have reached the platform). */
  sendTimeoutMs: number;
}

export interface AnswerDeliveryOptions {
  /** The channel component's name: its wakeup (`${name}.answers`) and its log lines. */
  name: string;
  /** `agent.submissions`' `answers`. */
  answers: Feed<RunSettlement>;
  /** The channel's namespace of `storage.kv`: its cursor and its marks. */
  store: KeyValueStore;
  /** Each instance's transport, by instance (`telegram`, `telegram:ops`). Attached to `queue` while delivery runs. */
  transports: ReadonlyMap<string, ChannelTransport>;
  /** The instance whose conversation `conversationKey` is, or `undefined` when it is not this channel's. */
  route(conversationKey: string): string | undefined;
  /** What the user is told about a run, or `undefined` to tell nothing (an aborted run, an empty answer). */
  text(answer: RunSettlement): string | undefined;
  /** `outbound.queue`, when installed: answers are enqueued, and it sends them. */
  queue?: OutboundQueue | undefined;
  /** `wakeups`, where nothing runs between events (a Durable Object). Absent: a timer in this process. */
  wakeups?: Wakeups | undefined;
  policy: DeliveryPolicy;
}

export interface AnswerDelivery {
  /** Something may be due (a run of the channel ended): read soon. */
  wake(ctx: AppContext): Promise<void>;
  /**
   * Stops: nothing more is sent, a send in flight is aborted (its piece stays `sending`, and goes
   * again, marked, at the next start), the transports are detached from the queue. Resolves once the
   * run in progress ended, or when `signal` (the channel's stop deadline) aborts.
   */
  stop(signal?: AbortSignal): Promise<void>;
}

const CURSOR_KEY = "answers-cursor";
const SENDING = "sending";
const SENT = "sent";
/** Answers read from the feed at a time. */
const PAGE = 50;

const pieceMark = (key: string, index: number): string => `piece:${key}#${index}`;
const doneMark = (key: string): string => `answer:${key}`;

/** What became of one answer in a run. */
type Outcome = { kind: "done" } | { kind: "cut" } | { kind: "failed"; error: unknown };

/** One conversation's retries: in memory, so a restart just tries again. */
interface Lane {
  failures: number;
  notBefore: number;
}

/**
 * Starts delivering the channel's answers, from its saved cursor. Call it in the channel's `start`,
 * once its transports work; call `wake` when one of its runs ends, and `stop` in its `stop`.
 * Rejects when `wakeups` refuses the handler (its name is taken).
 */
export async function startAnswerDelivery(ctx: AppContext, options: AnswerDeliveryOptions): Promise<AnswerDelivery> {
  const { name, answers, store, transports, queue, policy } = options;
  const wakeup = `${name}.answers`;
  const stopping = new AbortController();
  const lanes = new Map<string, Lane>();
  let readFailures = 0;
  /** A wake came during a run: the run's own next request must not put it off. */
  let kicked = false;
  /** The cursor after which a gap was last reported: each gap once. */
  let gapAfter: string | undefined | null = null;
  let running: Promise<void> | undefined;

  const backoff = (failures: number): number => policy.retryMs[Math.min(failures, policy.retryMs.length) - 1] ?? 1_000;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /** Delivers one answer of `instance`: enqueued, or each piece sent. */
  const deliverOne = async (fact: RunSettlement, instance: string, text: string, transport: ChannelTransport, budget: { left: number }, run: AppContext, signal: AbortSignal): Promise<Outcome> => {
    const key = answerKey(fact.conversation, fact.requestId);
    if ((await store.get(doneMark(key))) !== undefined) return { kind: "done" };
    if (queue !== undefined) {
      try {
        await queue.enqueue({ idempotencyKey: key, channel: instance, conversationKey: fact.conversation.key, text });
      } catch (error) {
        return { kind: "failed", error };
      }
      await store.set(doneMark(key), 0);
      return { kind: "done" };
    }
    const pieces = transport.split(text);
    for (const [index, piece] of pieces.entries()) {
      const mark = pieceMark(key, index);
      const state = await store.get<string>(mark);
      if (state === SENT) continue;
      if (signal.aborted || budget.left <= 0) return { kind: "cut" };
      budget.left--;
      await store.set(mark, SENDING);
      try {
        await transport.send(
          { key: `${key}#${index}`, conversationKey: fact.conversation.key, text: piece, possibleDuplicate: state === SENDING },
          AbortSignal.any([signal, AbortSignal.timeout(policy.sendTimeoutMs)]),
        );
      } catch (error) {
        // Cut (a stop, the slice's deadline): it may have reached the platform, and stays `sending`.
        if (signal.aborted) return { kind: "cut" };
        // Refused before it left: not a possible duplicate. Anything else (a timeout) may have arrived.
        if (error instanceof DeliveryError && !error.maybeSent) await store.delete(mark);
        if (error instanceof DeliveryError && error.kind === "permanent") {
          run.logger.error(`${name}: the platform refused an answer for good; it is not sent`, { conversation: fact.conversation.key, run: fact.requestId, error: error.message });
          break;
        }
        return { kind: "failed", error };
      }
      await store.set(mark, SENT);
    }
    await store.set(doneMark(key), pieces.length);
    return { kind: "done" };
  };

  /** Deletes an answer's marks, once the cursor is past it. */
  const forget = async (fact: RunSettlement): Promise<void> => {
    const key = answerKey(fact.conversation, fact.requestId);
    const pieces = await store.get<number>(doneMark(key));
    if (pieces === undefined) return;
    for (let index = 0; index < pieces; index++) await store.delete(pieceMark(key, index));
    await store.delete(doneMark(key));
  };

  /** One pass over the window: delivers what is due; when to run next (`undefined`: on a wake). */
  const pass = async (run: AppContext, signal: AbortSignal): Promise<number | undefined> => {
    const saved = await store.get<string>(CURSOR_KEY);
    const items: FeedItem<RunSettlement>[] = [];
    let after = saved;
    let full = false;
    while (items.length < policy.window) {
      const limit = Math.min(PAGE, policy.window - items.length);
      const page = await answers.read(after, limit);
      if (page.gap && gapAfter !== after) {
        gapAfter = after;
        run.logger.warn(`${name}: answers were pruned before this channel read them; some may not have reached their conversations`, { after });
      }
      items.push(...page.items);
      after = page.items.at(-1)?.cursor ?? after;
      if (page.items.length < limit) break;
      full = items.length >= policy.window;
    }

    const now = run.clock.now();
    const settled = items.map(() => false);
    /** Each conversation's answers in this window, in the feed's order: indexes into `items`. */
    const byConversation = new Map<string, number[]>();
    const routed = new Map<number, { instance: string; text: string; transport: ChannelTransport }>();
    for (const [index, { fact }] of items.entries()) {
      const instance = options.route(fact.conversation.key);
      const transport = instance === undefined ? undefined : transports.get(instance);
      const text = transport === undefined ? undefined : options.text(fact);
      // Another channel's conversation, a bot that does not run, or nothing to tell: passed over.
      if (instance === undefined || transport === undefined || text === undefined) {
        settled[index] = true;
        continue;
      }
      routed.set(index, { instance, text, transport });
      byConversation.set(fact.conversation.key, [...(byConversation.get(fact.conversation.key) ?? []), index]);
    }

    const budget = { left: policy.piecesPerRun };
    let cut = false;
    let next: number | undefined;
    const later = (time: number) => (next = next === undefined ? time : Math.min(next, time));
    await Promise.all(
      [...byConversation].map(async ([conversation, indexes]) => {
        const lane = lanes.get(conversation);
        if (lane !== undefined && lane.notBefore > now) return void later(lane.notBefore);
        for (const index of indexes) {
          const { fact } = items[index] as FeedItem<RunSettlement>;
          const { instance, text, transport } = routed.get(index) as { instance: string; text: string; transport: ChannelTransport };
          const outcome = await deliverOne(fact, instance, text, transport, budget, run, signal);
          if (outcome.kind === "cut") {
            cut = true;
            return;
          }
          if (outcome.kind === "failed") {
            const rateLimited = outcome.error instanceof DeliveryError && outcome.error.kind === "rate_limited";
            const failures = (lane?.failures ?? 0) + (rateLimited ? 0 : 1);
            const wait = rateLimited ? ((outcome.error as DeliveryError).retryAfterMs ?? backoff(Math.max(failures, 1))) : backoff(failures);
            lanes.set(conversation, { failures, notBefore: run.clock.now() + wait });
            later(run.clock.now() + wait);
            const details = { conversation, run: fact.requestId, failures, error: describe(outcome.error) };
            if (failures >= policy.blockedAfter) run.logger.error(`${name}: an answer still cannot be delivered; its conversation's later answers wait for it`, details);
            else run.logger.warn(`${name}: delivering an answer failed; trying again`, details);
            return;
          }
          lanes.delete(conversation);
          settled[index] = true;
        }
      }),
    );

    // The cursor moves past the answers delivered in a row from it, then their marks go.
    let head = saved;
    let passed = 0;
    while (passed < items.length && settled[passed]) head = (items[passed++] as FeedItem<RunSettlement>).cursor;
    if (head !== undefined && head !== saved) {
      await store.set(CURSOR_KEY, head);
      for (const item of items.slice(0, passed)) await forget(item.fact);
    }
    if (cut || (full && head !== saved)) return run.clock.now();
    return next;
  };

  /** One run: a pass, then the request for the next one. Never rejects: a failed read waits and tries again. */
  const runOnce = async (run: AppContext): Promise<void> => {
    if (stopping.signal.aborted) return;
    kicked = false;
    const signal = run.abortSignal === undefined ? stopping.signal : AbortSignal.any([run.abortSignal, stopping.signal]);
    let next: number | undefined;
    try {
      next = await pass(run, signal);
      readFailures = 0;
    } catch (error) {
      if (stopping.signal.aborted) return;
      readFailures++;
      run.logger.warn(`${name}: reading answers or saving the cursor failed; trying again`, { failures: readFailures, error: describe(error) });
      next = run.clock.now() + backoff(readFailures);
    }
    if (stopping.signal.aborted) return;
    if (kicked) next = run.clock.now();
    if (next !== undefined) await schedule.at(next, run);
  };
  /** A run, kept while it goes: `stop` waits for it. */
  const tracked = (run: AppContext): Promise<void> => {
    const current = runOnce(run);
    running = current;
    const done = () => {
      if (running === current) running = undefined;
    };
    current.then(done, done);
    return current;
  };

  const background = ctx.derive(() => BACKGROUND_CONTEXT);
  const schedule = options.wakeups === undefined ? timer(tracked, background) : onWakeups(options.wakeups, wakeup, tracked);

  for (const [instance, transport] of transports) queue?.attach(instance, transport);
  try {
    // Whatever ended while the channel did not run (a restart, an eviction, a deploy) is delivered now.
    await schedule.at(ctx.clock.now(), ctx);
  } catch (error) {
    stopping.abort();
    schedule.stop();
    for (const instance of transports.keys()) await queue?.detach(instance, ctx.abortSignal);
    throw error;
  }

  return {
    async wake(wakeCtx) {
      if (stopping.signal.aborted) return;
      kicked = true;
      await schedule.at(wakeCtx.clock.now(), wakeCtx);
    },
    async stop(signal) {
      stopping.abort(new Error(`${name}: stopping`));
      schedule.stop();
      const run = running;
      if (run !== undefined) await bounded(run, signal);
      for (const instance of transports.keys()) await queue?.detach(instance, signal);
    },
  };
}

/** How runs are asked for: `wakeups`, or a timer in this process. One request; a later `at` replaces it. */
interface Schedule {
  at(time: number, ctx: AppContext): Promise<void>;
  stop(): void;
}

/** Runs are the wakeup `name`'s: the provider drives them, one at a time, in slices. */
function onWakeups(wakeups: Wakeups, name: string, run: (ctx: AppContext) => Promise<void>): Schedule {
  wakeups.handle(name, run);
  return {
    at: (time, ctx) => wakeups.at(name, time, ctx),
    // The handler is dropped with the App; until then a run after stop does nothing.
    stop: () => {},
  };
}

/** Runs driven by a timer in this process, as `wakeups` would: one at a time, a request during a run stands after it. */
function timer(run: (ctx: AppContext) => Promise<void>, ctx: AppContext): Schedule {
  let due: number | undefined;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let inRun = false;
  let stopped = false;
  const arm = (): void => {
    clearTimeout(handle);
    handle = undefined;
    if (stopped || inRun || due === undefined) return;
    handle = setTimeout(fire, Math.max(0, due - ctx.clock.now()));
  };
  const fire = (): void => {
    handle = undefined;
    if (stopped || inRun) return;
    due = undefined;
    inRun = true;
    void run(ctx)
      .catch(() => {})
      .finally(() => {
        inRun = false;
        arm();
      });
  };
  return {
    async at(time) {
      due = time;
      arm();
    },
    stop() {
      stopped = true;
      clearTimeout(handle);
    },
  };
}

/** Waits for `work`, or until `signal` aborts. Never rejects. */
function bounded(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  const settled = work.catch(() => {});
  if (signal === undefined) return settled;
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
    void settled.then(resolve);
  });
}
