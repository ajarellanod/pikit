/**
 * `agent.runtime` and `agent.submissions` on pi-durable (@pikit/contracts' agent.ts, submissions.ts).
 * README.md, "The runtime" and "Submissions", has the mapping; in short:
 *
 * - **One `Harness` per storage**, opened at first use and owned by the runtime from then on; pi-durable
 *   allows one per storage and one process per storage. Opening it reconfigures the conversations that
 *   have live work and resumes the scheduler, so a run a dead worker left open continues (pi-durable's
 *   scheduler is global: it runs every conversation's work, not one conversation's).
 * - **`ConversationRef.conversationId` is the pi-durable conversation id** (a number, as a string).
 *   `createConversation` makes one (`conversations: "ownerless"`, a server's many conversations in one
 *   storage; `"root"`, the root conversation first, as in a per-chat Durable Object).
 * - **`dispatch`** submits the prompt as an `input` with the request id: a request id pi-durable already
 *   holds is `duplicate`; an input it queued in the inbox (a run is going) is `queued`; an input it placed
 *   at once is `started`. An input is a follow-up unless the request steers (`whenBusy: "steer"`).
 *   Follow-ups are placed all at once (`followUpMode: "all"`): the messages queued while a run goes start
 *   the next run together, whose `requestIds` lists them all and whose `agent.started` names the first.
 *   Steers are placed after the run's current tool round, all at once (`steeringMode: "all"`), and join
 *   that run (`pi.live.run.inputs`), which settles them with its other inputs; a run that answers before
 *   another tool round places them as the next run's inputs.
 * - **Settlements** are read from pi-durable's commits: the inputs of a run settle in one commit, and
 *   are one `AgentResult`. Settled `done` is `agent.settled` (completed), `unanswered` with `aborted` is
 *   `agent.settled` (aborted), any other reason is `agent.failed` with that reason as its code. One
 *   withdrawn while queued (an abort) is logged in `answers`, unannounced.
 * - **`agent.submissions`** is read from pi-durable, which holds every submission: `get` and `pending`
 *   are its records; `answers` is a log derived from them (`answers.ts`), appended once per run (its
 *   run key) by `settle`, live from the commits or by `reconcile` after a crash (`submissions.ts`).
 *   The runtime is its only writer: giving up on messages is `abandon`, the runtime's own.
 * - **Agents** are applied by `AgentConfigs` (`agent.ts`): each conversation's `pi.agent` selects the
 *   agent's tool extension and the extensions it names (`agent.extension`, resolved through `extension`).
 *
 * Steps that touch one conversation (admissions, aborts, recoveries, settlements) run in that
 * conversation's line, one at a time, so a duplicate check and the submit after it never interleave,
 * and a run is logged and announced by one step only.
 */

import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
  type CommitChange,
  type Conversation,
  type ConversationId,
  Harness,
  type HarnessInspection,
  type HarnessOptions,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionRecord,
  type TaskInspection,
  createRegistry,
} from "@earendil-works/pi-durable";
import { type AppContext, type AppEvents, withContextValue } from "@pikit/core";
import {
  type Admission,
  AGENT_STATE,
  type AgentDefinition,
  type AgentRequest,
  type AgentResult,
  type AgentRuntime,
  type AgentState,
  type AgentSubmissions,
  CONVERSATION,
  type ConversationRef,
  isJsonObject,
  type PendingConversation,
  type RunSettlement,
  type SqlDatabase,
} from "@pikit/contracts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { AgentConfigs, AgentStateDoc, ConversationDoc, type DurableExtension, type DurableModels, type DurableTool, effectiveState } from "./agent.ts";
import { createAnswerLog } from "./answers.ts";
import { runContext, toChord } from "./context.ts";
import { harnessEnv } from "./execution.ts";
import type { WorkspaceProvider } from "./types.ts";
import { isSettledInput, type SettledInput, settlementOf, toResult } from "./result.ts";
import { openDurableStorage } from "./sql.ts";
import { ABANDONED, AdmissionsDoc, announced, durableId, runKey, runsOf, storedRunsOf } from "./submissions.ts";

export interface DurableRuntimeOptions {
  /**
   * The app's `storage.sql` (SQLite: storage-sqlite, storage-do). pi-durable's storage is opened over it
   * (`openDurableStorage`) at first use, and the runtime's Harness owns it from then on; the answers log
   * is kept there too (`runtime_pi_answers`), so both live and go with one database.
   */
  db: SqlDatabase;
  /** Days a run stays in `answers` (and `get` reads it from there). Default 7, at least 1. */
  keepSettledDays?: number;
  /** The definition of an agent by name (`agent.definition`), or `undefined` if none has it. */
  agent(name: string): AgentDefinition | undefined;
  /** An installed tool by name (`agent.tool`), for the tools agents name. Without it, only tool objects work. */
  tool?(name: string): DurableTool | undefined;
  /**
   * An installed agent extension by name (`agent.extension`), for the extensions agents name; read each
   * time an agent is applied. Without it, an agent that names an extension cannot run.
   */
  extension?(name: string): DurableExtension | undefined;
  /** pi-ai 1.0's models: every model the agents may name (`provider/modelId`). */
  models: DurableModels;
  /**
   * Where runs report when no caller context is known. Derive it once from `start`'s context:
   * `ctx.derive(() => BACKGROUND_CONTEXT)`, never `start`'s context itself (its deadline). Its values
   * are the Harness's: every task, tool calls included, runs in it.
   */
  events: AppContext;
  /**
   * What `createConversation` makes: `ownerless` (default) a new ownerless conversation each time, for a
   * storage that holds many (a server); `root` the storage's root conversation the first time, then
   * ownerless ones (after a reset), for a storage per conversation (a per-chat Durable Object).
   */
  conversations?: "ownerless" | "root";
  /**
   * pi-durable's run policy (stream, retry, compaction, tool execution). The queue modes are the
   * runtime's (queued follow-ups are taken all at once by the next run, steers all at once by the run
   * in progress). Extensions are not a host default: each conversation selects exactly its agent's
   * (`AgentDefinition.extensions`, through `extension`), so a default selection would never apply.
   */
  settings?: Omit<HarnessSettings, "extensions" | "steeringMode" | "followUpMode">;
  /**
   * Builds a conversation's execution environment for its tools (pi-durable's `HarnessOptions.env`).
   * Default: `harnessEnv` over `workspace` and `execution` below.
   */
  env?: HarnessOptions["env"];
  /** The `execution` capability, read at each tool call: the environment of a conversation without a workspace. */
  execution?(): ExecutionEnv | undefined;
  /** The `workspace` capability, read at each tool call: the conversation's own environment, when installed. */
  workspace?(): WorkspaceProvider | undefined;
  /** The clock pi-durable and the answers log use (epoch ms); workerd freezes `Date.now()` between I/O. */
  now?: () => number;
  /**
   * For a host that keeps running only while an event is in progress (a Durable Object): called by
   * `whenIdle` when nothing is driven but live work waits for a time (a model retry's backoff, a
   * deferred response's poll, a compaction's retry). Those waits are in-process sleeps that die with the
   * host, so the host asks to be woken when the earliest is due (computed from `inspection`, see
   * `wakeups.ts`); a reopened Harness continues them. A rejection is logged.
   */
  onIdleWithPendingWork?(inspection: HarnessInspection, ctx: AppContext): Promise<void>;
}

export interface DurableRuntime extends AgentRuntime {
  /**
   * `agent.submissions`, read from pi-durable: `get` and `pending` are its records, `answers` the log of
   * every run's end. `dispatch` admits, a run's end settles, `abandon` gives up.
   */
  readonly submissions: AgentSubmissions;
  /**
   * A new conversation, for `conversations.registry` (a first message, a reset): its id, which is the
   * `ConversationRef.conversationId` of every message to it.
   */
  createConversation(ctx: AppContext): Promise<string>;
  /**
   * Close the Harness but keep the runtime: the next call opens it again (and resumes what it finds).
   * For a host that is evicted between events (a Durable Object): an idle Harness whose remaining
   * work only waits for a time keeps an in-process timer, which keeps the object alive; closed, the
   * object can go, and the wake-up the host scheduled (`onIdleWithPendingWork`) reopens it. Waits for
   * the steps and announcements under way first. Call it inside an event of the host.
   */
  suspend(ctx: AppContext): Promise<void>;
  /**
   * Bring back a conversation with requests pending (`submissions.pending`), as a host does at start:
   * it is reconfigured, its work resumed, and what pi-durable settled without the run being logged is
   * logged and announced (`reconcile`). Resolves once those of `requestIds` pi-durable still runs or
   * queues have settled, or when `ctx` is cancelled. A conversation that can never run (its agent is no
   * longer defined: `agent_removed`; it is not in the storage: `conversation_missing`) has its queued
   * requests abandoned.
   */
  recover(conversation: ConversationRef, requestIds: readonly string[], ctx: AppContext): Promise<void>;
  /**
   * Give up on requests nothing can answer: those of `requestIds` pi-durable still queues are settled
   * unanswered (reason `abandoned`, detail `reason`) in one commit, logged as one run and announced as
   * `agent.failed` (code `abandoned`, message `reason`). One a run took (`placed`) is left to it, logged.
   */
  abandon(conversation: ConversationRef, requestIds: readonly string[], reason: string, ctx: AppContext): Promise<void>;
  /** Whether this worker drives the conversation now: a run going, or a step or an announcement under way. */
  holds(conversation: Pick<ConversationRef, "conversationId">): boolean;
  /**
   * Resolves `true` once nothing is driven: no task running, no step or announcement under way (work
   * that only waits for a time does not count; `onIdleWithPendingWork` is told about it). `false` as
   * soon as `ctx` is cancelled or the runtime closed.
   */
  whenIdle(ctx: AppContext): Promise<boolean>;
  /** The conversation's `agent.state`, as its tools reach it through `AGENT_STATE`. */
  state(conversation: ConversationRef): AgentState;
  /** pi-durable's live work: tasks and unsettled submissions (opens the Harness). */
  inspect(ctx: AppContext): Promise<HarnessInspection>;
  /** Close the Harness: runs in progress stop and stay pending in the storage; the next worker resumes them. */
  close(ctx: AppContext): Promise<void>;
}

/** Why a conversation can never run: what `recover` abandons its requests for. */
class Unopenable extends Error {
  constructor(
    readonly reason: "agent_removed" | "conversation_missing",
    message: string,
  ) {
    super(message);
  }
}

/** `pi.live`, whose `run` says a conversation is busy. */
const LIVE = "pi.live";

/** The kind of the write that starts a run for inputs a failed run left queued (README.md, "Gaps"). */
export const INBOX_KICK = "pikit.inbox-kick";

const DAY = 24 * 60 * 60 * 1_000;
/** The answers log is pruned when the Harness opens, and at most this often after, when a run is logged. */
const PRUNE_EVERY_MS = 60 * 60 * 1_000;
/** Page size of submission scans. */
const SCAN = 500;

/** A run's announcement: the context its events go to, and what its end waits for (its `agent.started`). */
interface RunAnnouncement {
  ctx: AppContext;
  announced: Promise<void>;
}

export function createDurableRuntime(options: DurableRuntimeOptions): DurableRuntime {
  const events = options.events;
  const logger = events.logger;
  const registry = createRegistry();
  const now = options.now ?? Date.now;
  const keepMs = Math.max(1, options.keepSettledDays ?? 7) * DAY;
  const log = createAnswerLog(options.db);
  /** The log's tables, created once (reading `answers` does not need the Harness). */
  let logReady: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (logReady ??= log.ensure().catch((error: unknown) => {
      logReady = undefined;
      throw error;
    }));
  let prunedAt = 0;
  let closed = false;
  let opening: Promise<Harness> | undefined;
  /** The storage under the open Harness (read directly: scans and entry commit sequences). */
  let storage: Storage | undefined;
  /** A `suspend` closing the Harness: the next open waits for it (one Harness per storage). */
  let suspending: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;

  /** Every promise in flight (steps, settlements, announcements): what `whenIdle` and `close` wait for. */
  const inflight = new Set<Promise<unknown>>();
  /** Per conversation, its line of steps. */
  const lines = new Map<ConversationId, { tail: Promise<unknown>; queued: number }>();
  /** Conversations with a run going (`pi.live.run`), from the commits. */
  const busy = new Set<ConversationId>();
  /** Per conversation, announcements under way. */
  const announcing = new Map<ConversationId, number>();
  /** Input submissions seen queued, whose placing starts their run (`agent.started`). */
  const queued = new Set<number>();
  /** Per placed input, the first input of its run (`pi.live.run.inputs[0]`): the one a run is named after. */
  const leadOf = new Map<number, number>();
  /** Per request key, the status a submission was created with (set while `dispatch` submits it). */
  const admitting = new Map<string, SubmissionRecord["status"] | undefined>();
  /** Per request key, its run's announcement. */
  const runs = new Map<string, RunAnnouncement>();
  /** Per submission id, who waits for its settlement to be handled (`recover`, `abandon`). */
  const handled = new Map<number, (() => void)[]>();
  /** Known `ConversationRef`s by conversation id. */
  const refs = new Map<ConversationId, ConversationRef>();
  /** Resolved at each commit. */
  let commitWaiters: (() => void)[] = [];
  let resolveClosed!: () => void;
  const closedSignal = new Promise<void>((resolve) => (resolveClosed = resolve));

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    const done = () => void inflight.delete(work);
    work.then(done, done);
    return work;
  };

  const inLine = <T>(id: ConversationId, work: () => Promise<T>): Promise<T> => {
    let line = lines.get(id);
    if (line === undefined) {
      line = { tail: Promise.resolve(), queued: 0 };
      lines.set(id, line);
    }
    const current = line;
    current.queued++;
    const next = current.tail.then(work);
    current.tail = next
      .catch(() => {})
      .then(() => {
        current.queued--;
        if (current.queued === 0 && lines.get(id) === current) lines.delete(id);
      });
    return track(next);
  };

  const keyOf = (id: ConversationId, requestId: string) => `${id}\u0000${requestId}`;

  const config = new AgentConfigs({
    models: options.models,
    registry,
    tool: options.tool,
    extension: options.extension,
    // Each tool runs with its conversation and that conversation's state in its context.
    wrap: (tool) => ({
      ...tool,
      execute: async (args, api, ctx) => {
        const ref = await refOf(api.conversationId);
        if (ref === undefined) return tool.execute(args, api, ctx);
        return tool.execute(args, api, toChord(withContextValue(CONVERSATION, ref, withContextValue(AGENT_STATE, stateOf(ref), ctx))));
      },
    }),
  });

  /** Each tool call's environment: its conversation's workspace when a provider is installed, else `execution`. */
  const env: HarnessOptions["env"] =
    options.env ??
    (options.execution === undefined && options.workspace === undefined
      ? undefined
      : harnessEnv({
          execution: () => options.execution?.(),
          workspace: async (target, context) => {
            const provider = options.workspace?.();
            if (provider === undefined) return undefined;
            const ref = await refOf(target.conversationId);
            if (ref === undefined) throw new Error(`workspace: conversation ${target.conversationId} has no ConversationRef`);
            return (await provider.resolve(ref, context)).env;
          },
        }));

  const harnessOf = (ctx: AppContext): Promise<Harness> => {
    if (closed) return Promise.reject(new Error("agent.runtime is closed"));
    opening ??= (suspending ?? Promise.resolve())
      .then(() => openHarness(ctx))
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    return opening;
  };

  /** The open Harness and its storage. */
  const opened = async (ctx: AppContext): Promise<{ harness: Harness; storage: Storage }> => {
    const harness = await harnessOf(ctx);
    if (storage === undefined) throw new Error("agent.runtime: the Harness is open without its storage");
    return { harness, storage };
  };

  /**
   * Open the Harness, reconfigure the conversations with live work (their agents may have changed with
   * a deploy, and their tools must be installed before anything runs), resume the scheduler, announce
   * the runs it resumes, start runs for messages a failed run left queued, and reconcile the
   * conversations that may hold a settlement a crash left unlogged.
   */
  const openHarness = async (ctx: AppContext): Promise<Harness> => {
    await ready();
    const store = await openDurableStorage(options.db);
    const harness = await Harness.open(
      store,
      {
        models: options.models,
        registry,
        // Follow-ups queued while a run goes start the next run together; steers join the run in
        // progress together, after its tool round. A steer is placed in a later commit than the run's
        // other inputs: live and answered runs are still grouped exactly (by the settling commit, by
        // the answer), but a failed run that took a steer, found after a crash, is grouped by placing
        // commit and its steer announced apart (submissions.ts says how steers will be grouped).
        settings: { ...options.settings, steeringMode: "all", followUpMode: "all" },
        ...(env !== undefined && { env }),
        now,
        onReport: (error) => logger.warn("pi-durable reported a failure", { error: error instanceof Error ? error.message : String(error) }),
      },
      // Tasks run in the Harness's context: the app's values, never a caller's cancellation.
      toChord(runContext(events)),
    );
    if (closed) {
      await harness.close(toChord(ctx)).catch(() => {});
      throw new Error("agent.runtime is closed");
    }
    storage = store;
    unsubscribe = harness.subscribeCommits((publication) => observe(publication.changes));
    try {
      await prepareOpened(harness, ctx);
    } catch (error) {
      // Never leave a second Harness over the storage for the next attempt to race.
      unsubscribe();
      storage = undefined;
      await harness.close(toChord(ctx)).catch(() => {});
      throw error;
    }
    void track(prune(now()));
    return harness;
  };

  /** What opening does once the Harness is open: see `openHarness`. */
  const prepareOpened = async (harness: Harness, ctx: AppContext): Promise<void> => {
    const inspection = await harness.inspect(toChord(ctx));
    const live = new Set<ConversationId>([...inspection.tasks.map((task) => task.record.conversationId)]);
    const resumed: SubmissionRecord[] = [];
    const waiting = new Set<ConversationId>();
    for (const submission of inspection.submissions) {
      live.add(submission.conversationId);
      if (submission.type !== "input" || submission.requestId === undefined) continue;
      if (submission.status === "queued") {
        queued.add(submission.id);
        waiting.add(submission.conversationId);
      } else if (submission.status === "placed") {
        busy.add(submission.conversationId);
        resumed.push(submission);
      }
    }
    for (const id of live) {
      await reconfigure(harness, id, ctx).catch((error: unknown) => {
        logger.error("a conversation with live work could not be reconfigured; it resumes with its last agent", {
          conversation: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // A resumed run is announced once, named after its first input (the others were queued with it).
    for (const id of new Set(resumed.map((submission) => submission.conversationId))) {
      const inputs = (await harness.snapshot(LiveDoc, id, toChord(ctx)))?.run?.inputs ?? [];
      for (const input of inputs) leadOf.set(input, inputs[0] as number);
    }
    for (const submission of resumed) {
      const ref = await refOf(submission.conversationId, harness);
      if (ref === undefined || submission.requestId === undefined) continue;
      if ((leadOf.get(submission.id) ?? submission.id) !== submission.id) continue;
      const requestId = submission.requestId;
      const key = keyOf(submission.conversationId, requestId);
      // Announced by this runtime before a `suspend`: not announced again.
      if (runs.has(key)) continue;
      runs.set(key, { ctx: events, announced: emit(events, "agent.started", { conversation: ref, requestId, resumed: true }) });
    }
    harness.resume();
    for (const id of waiting) {
      if (!busy.has(id)) void inLine(id, () => reconcileInbox(harness, id)).catch(logFailure("starting a run for queued messages failed"));
    }
    // A run may have ended with its log never written (a crash between the two): logged and announced now.
    const admissions = await harness.snapshot(AdmissionsDoc, toChord(ctx));
    for (const key of Object.keys(admissions?.conversations ?? {})) {
      const id = durableId(key);
      if (id !== undefined) void inLine(id, () => reconcile(harness, id)).catch(logFailure("reconciling a conversation's answers failed"));
    }
  };

  /**
   * Every commit: inputs queued, placed (a queued one's run starts: `agent.started`), settled (logged
   * and announced in their conversation's line); conversations' runs starting and ending. Must not call
   * the Harness.
   */
  const observe = (changes: readonly CommitChange[]) => {
    // The runs that start in this commit, first: a run's inputs are placed in the commit that starts it.
    for (const change of changes) {
      if (change.type !== "document" || change.record.kind !== LIVE || change.conversationId === undefined) continue;
      const value = change.value as { run?: { inputs?: number[] } } | null;
      if (value?.run !== undefined) busy.add(change.conversationId);
      else busy.delete(change.conversationId);
      const inputs = value?.run?.inputs ?? [];
      for (const input of inputs) if (!leadOf.has(input)) leadOf.set(input, inputs[0] as number);
    }
    /** Per conversation, the inputs this commit settled: one run's (and those an abort withdrew). */
    const settled = new Map<ConversationId, SettledInput[]>();
    for (const change of changes) {
      if (change.type !== "submission") continue;
      const record = change.value;
      if (record.type !== "input" || record.requestId === undefined) continue;
      const key = keyOf(record.conversationId, record.requestId);
      if (admitting.has(key) && admitting.get(key) === undefined) admitting.set(key, record.status);
      if (record.status === "queued") {
        queued.add(record.id);
      } else if (record.status === "placed") {
        // Only the first input of a run announces it; the others were queued with it.
        if (queued.delete(record.id) && (leadOf.get(record.id) ?? record.id) === record.id) startedFromQueue(record.conversationId, record.requestId);
      } else if (isSettledInput(record)) {
        queued.delete(record.id);
        settled.set(record.conversationId, [...(settled.get(record.conversationId) ?? []), record]);
      }
    }
    for (const [id, records] of settled) {
      void inLine(id, async () => settle(await harnessOf(events), id, runsOf(records), [])).catch(logFailure("a run ended but it could not be logged"));
    }
    const waiters = commitWaiters;
    commitWaiters = [];
    for (const wake of waiters) wake();
  };

  /** A queued request's run started: `agent.started`, after the announcements of its admission. */
  const startedFromQueue = (id: ConversationId, requestId: string): void => {
    const key = keyOf(id, requestId);
    const before = runs.get(key);
    const ctx = before?.ctx ?? events;
    const announced = Promise.resolve(before?.announced)
      .then(() => refOf(id))
      .then((ref) => (ref === undefined ? undefined : emit(ctx, "agent.started", { conversation: ref, requestId, resumed: false })));
    runs.set(key, { ctx, announced });
    countAnnouncing(id, announced);
  };

  const countAnnouncing = (id: ConversationId, work: Promise<unknown>): void => {
    announcing.set(id, (announcing.get(id) ?? 0) + 1);
    void track(work).finally(() => {
      const left = (announcing.get(id) ?? 1) - 1;
      if (left === 0) announcing.delete(id);
      else announcing.set(id, left);
    });
  };

  /** Emit, logging a listener's failure: an event never fails the run that announces it. */
  const emit = async <K extends "agent.started" | "agent.settled" | "agent.failed">(ctx: AppContext, name: K, payload: AppEvents[K]): Promise<void> => {
    try {
      await ctx.emit(name, payload);
    } catch (error) {
      logger.error(`a listener of ${name} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Prunes the answers log past its retention; a failure only delays it. */
  const prune = async (at: number): Promise<void> => {
    prunedAt = at;
    await log.prune(at - keepMs).catch((error: unknown) => logger.warn("pruning the answers log failed", { error: String(error) }));
  };

  /**
   * Log and announce runs of one conversation (`groups`: each a run's settled inputs, oldest first, in
   * the order to log them), in its line. The one path for a run's end, live or reconciled:
   * 1. only runs whose requests are still in `AdmissionsDoc` count (not logged yet; another step of
   *    the line may have logged them);
   * 2. they are appended to the answers log, idempotently by run key, in one transaction;
   * 3. their requests (and `gone`, requests pi-durable never held) leave `AdmissionsDoc`, in one commit;
   * 4. each is announced, once the announcements of its admission are out (not inputs an abort withdrew
   *    while queued), and a run that ended unanswered gets what it left queued started.
   * A crash between 2 and 3 appends the same keys again: nothing changes.
   */
  const settle = async (harness: Harness, id: ConversationId, groups: readonly SettledInput[][], gone: readonly string[]): Promise<void> => {
    try {
      const chord = toChord(events);
      const unlogged = (await harness.snapshot(AdmissionsDoc, chord))?.conversations[String(id)] ?? {};
      const pending = groups.filter((group) => group.some((record) => record.requestId !== undefined && Object.hasOwn(unlogged, record.requestId)));
      if (pending.length === 0 && gone.length === 0) return;
      const ref = await refOf(id, harness);
      const conversation = await harness.conversation(id, chord);
      if (ref === undefined || conversation === undefined) return;
      const results: AgentResult[] = [];
      for (const group of pending) results.push(await toResult(conversation, ref, group, chord));
      const at = now();
      await log.append(
        pending.map((group, index) => ({ key: runKey(group), run: settlementOf(results[index] as AgentResult) })),
        at,
      );
      await harness.commit(async (tx) => {
        const admissions = await tx.doc(AdmissionsDoc);
        const mine = admissions.conversations[String(id)];
        if (mine === undefined) return;
        for (const requestId of [...pending.flat().map((record) => record.requestId ?? ""), ...gone]) delete mine[requestId];
        if (Object.keys(mine).length === 0) delete admissions.conversations[String(id)];
      }, chord);
      if (at - prunedAt >= PRUNE_EVERY_MS) void track(prune(at));
      for (const [index, group] of pending.entries()) {
        const announcements = group.flatMap((record) => {
          const key = keyOf(record.conversationId, record.requestId ?? "");
          const announcement = runs.get(key);
          runs.delete(key);
          return announcement === undefined ? [] : [announcement];
        });
        for (const record of group) leadOf.delete(record.id);
        if (announced(group)) countAnnouncing(id, announce(results[index] as AgentResult, announcements[0]?.ctx ?? events, announcements));
      }
      if (pending.some((group) => group[0]?.status === "unanswered" && group[0].entry !== undefined)) await reconcileInbox(harness, id);
    } finally {
      for (const record of groups.flat()) {
        const waiters = handled.get(record.id);
        handled.delete(record.id);
        for (const wake of waiters ?? []) wake();
      }
    }
  };

  /**
   * Log and announce, at once, every run of the conversation that pi-durable settled and that is not
   * logged yet: the requests in `AdmissionsDoc` it holds settled, grouped exactly by run
   * (`storedRunsOf`), so a run is never split nor merged with another, and has the key it would have
   * had live: one appended before a crash is not appended again. The same path as a live settlement (`settle`); after a crash, on a redelivery,
   * at start and in `recover`. In the conversation's line.
   */
  const reconcile = async (harness: Harness, id: ConversationId): Promise<void> => {
    const chord = toChord(events);
    const unlogged = (await harness.snapshot(AdmissionsDoc, chord))?.conversations[String(id)];
    if (unlogged === undefined || storage === undefined) return;
    const stored = storage;
    const settled: SettledInput[] = [];
    const gone: string[] = [];
    for (const requestId of Object.keys(unlogged)) {
      const record = await stored.submissionByRequest(id, requestId, chord);
      // Never held: its submit failed after the admission was written (`dispatch` runs in this line).
      if (record === undefined) gone.push(requestId);
      else if (isSettledInput(record)) settled.push(record);
    }
    await settle(harness, id, await storedRunsOf(stored, settled, chord), gone);
  };

  /** Announce a run's result in `ctx`, once the announcements before it (admissions, `agent.started`) are out. */
  const announce = async (result: AgentResult, ctx: AppContext, before: readonly RunAnnouncement[]): Promise<void> => {
    await Promise.all(before.map((announcement) => announcement.announced.catch(() => {})));
    if (result.kind === "failed") await emit(ctx, "agent.failed", { ...result, kind: "failed" });
    else await emit(ctx, "agent.settled", { ...result, kind: result.kind });
  };

  /**
   * pi-durable leaves the inputs queued behind a run that ended unanswered in the inbox, until the next
   * submission places them (pi-facts.test.ts). With no run going and inputs queued, a write submission
   * (an entry of kind `pikit.inbox-kick`, never seen by the model) runs the boundary that places the
   * oldest one and starts its run. In the conversation's line.
   */
  const reconcileInbox = async (harness: Harness, id: ConversationId): Promise<void> => {
    if (closed) return;
    const ctx = toChord(events);
    const [live, inbox] = await Promise.all([harness.snapshot(LiveDoc, id, ctx), harness.snapshot(InboxDoc, id, ctx)]);
    if (live?.run !== undefined || !(inbox?.items ?? []).some((item) => item.mode !== "write")) return;
    const conversation = await harness.conversation(id, ctx);
    await conversation?.submit({ type: "write", entry: { kind: INBOX_KICK } }, ctx);
  };

  /** The conversation's `ConversationRef`, from memory or its `pikit.conversation` document. */
  const refOf = async (id: ConversationId, open?: Harness): Promise<ConversationRef | undefined> => {
    const known = refs.get(id);
    if (known !== undefined) return known;
    const harness = open ?? (await harnessOf(events));
    const recorded = await harness.snapshot(ConversationDoc, id, toChord(events));
    if (recorded === undefined || recorded.key === "") return undefined;
    const ref = { key: recorded.key, agent: recorded.agent, conversationId: String(id) };
    refs.set(id, ref);
    return ref;
  };

  /** Make the conversation's agent what `prepare` gives for its current state; nothing when its agent is gone. */
  const reconfigure = async (harness: Harness, id: ConversationId, ctx: AppContext, given?: ConversationRef): Promise<void> => {
    const ref = given ?? (await refOf(id, harness));
    const agent = ref === undefined ? undefined : options.agent(ref.agent);
    if (ref === undefined || agent === undefined) return;
    await harness.commit(async (tx) => {
      const stored = copyJson(await tx.doc(AgentStateDoc, id)) as { [key: string]: JsonValue };
      await config.apply(tx, id, ref, agent, effectiveState(agent, stored), logger);
    }, toChord(ctx));
    refs.set(id, ref);
  };

  const conversationIdOf = (ref: Pick<ConversationRef, "conversationId" | "key">): ConversationId => {
    const id = durableId(ref.conversationId);
    if (id === undefined) throw new Unopenable("conversation_missing", `conversation ${ref.key}: "${ref.conversationId}" is not a pi-durable conversation id`);
    return id;
  };

  const conversationOf = async (harness: Harness, ref: ConversationRef, ctx: AppContext): Promise<Conversation> => {
    const conversation = await harness.conversation(conversationIdOf(ref), toChord(ctx));
    if (conversation === undefined) throw new Unopenable("conversation_missing", `conversation ${ref.key}: no pi-durable conversation ${ref.conversationId}`);
    return conversation;
  };

  const definitionOf = (ref: ConversationRef): AgentDefinition => {
    const agent = options.agent(ref.agent);
    if (agent === undefined) throw new Unopenable("agent_removed", `no agent.definition "${ref.agent}" for conversation ${ref.key}`);
    return agent;
  };

  /** `agent.state` of a conversation: reads its document, updates it with `pi.agent` in one commit. */
  const stateOf = (ref: ConversationRef): AgentState => ({
    async get(ctx) {
      const harness = await harnessOf(events);
      const stored = await harness.snapshot(AgentStateDoc, conversationIdOf(ref), toChord(ctx));
      return effectiveState(options.agent(ref.agent) ?? { name: ref.agent, model: "" }, stored);
    },
    async update(patch, ctx) {
      if (!isJsonObject(patch)) throw new TypeError("agent.state: a patch must be a JSON object");
      const copy = structuredClone(patch) as { [key: string]: JsonValue };
      const harness = await harnessOf(events);
      const id = conversationIdOf(ref);
      const agent = options.agent(ref.agent);
      // One commit: the update and the agent `prepare` gives for it. Commits are serial, so concurrent
      // updates never lose each other's keys.
      return harness.commit(async (tx) => {
        const draft = await tx.doc(AgentStateDoc, id);
        for (const [key, value] of Object.entries(copy)) draft[key] = value;
        const state = effectiveState(agent ?? { name: ref.agent, model: "" }, copyJson(draft) as { [key: string]: JsonValue });
        if (agent !== undefined) await config.apply(tx, id, ref, agent, state, logger);
        return state;
      }, toChord(ctx));
    },
  });

  const logFailure =
    (message: string) =>
    (error: unknown): void => {
      if (closed) return;
      logger.error(message, { error: error instanceof Error ? error.message : String(error) });
    };

  /** Resolves when the submission `id`'s settlement has been handled (registered in its line). */
  const whenHandled = (id: number): Promise<void> =>
    new Promise((resolve) => {
      const waiters = handled.get(id) ?? [];
      waiters.push(resolve);
      handled.set(id, waiters);
    });

  /**
   * `abandon`: settles those of `requestIds` pi-durable still queues unanswered, in one commit (a run
   * that took one keeps it), and waits until that settlement is logged and announced (`settle`, from
   * the commit). The settlement, or `undefined` when none was queued.
   */
  const abandonQueued = async (conversation: ConversationRef, requestIds: readonly string[], reason: string, ctx: AppContext): Promise<RunSettlement | undefined> => {
    const id = durableId(conversation.conversationId);
    if (id === undefined) return undefined;
    const harness = await harnessOf(ctx);
    const step = await inLine(id, async () => {
      if ((await harness.conversation(id, toChord(ctx))) === undefined) return undefined;
      const outcome = await harness.commit(async (tx) => {
        const taken: string[] = [];
        const withdrawn: SubmissionRecord[] = [];
        for (const requestId of new Set(requestIds)) {
          const record = await tx.submissionByRequest(id, requestId);
          if (record?.type !== "input") continue;
          if (record.status === "placed") taken.push(requestId);
          else if (record.status === "queued") withdrawn.push(record);
        }
        withdrawn.sort((a, b) => a.id - b.id);
        const inbox = withdrawn.length === 0 ? undefined : await tx.doc(InboxDoc, id);
        for (const record of withdrawn) {
          tx.settleSubmission(record.id, { status: "unanswered", reason: ABANDONED, detail: reason });
          const index = inbox?.items.findIndex((item) => item.id === record.id) ?? -1;
          if (index >= 0) inbox?.items.splice(index, 1);
        }
        return { taken, withdrawn };
      }, toChord(ctx));
      if (outcome.taken.length > 0) {
        ctx.logger.warn("pending requests a run took are not abandoned: the run settles them", { conversation: conversation.key, requests: outcome.taken, reason });
      }
      const [first] = outcome.withdrawn;
      // Registered in the step: the settlement's own step comes after it in the line.
      return first === undefined ? undefined : { withdrawn: outcome.withdrawn.map((record) => record.requestId ?? ""), logged: whenHandled(first.id) };
    });
    if (step === undefined) return undefined;
    await untilAborted(step.logged, ctx.abortSignal, closedSignal);
    const [first] = step.withdrawn;
    return { conversation, requestId: first as string, requestIds: step.withdrawn, kind: "failed", error: { code: ABANDONED, message: reason } };
  };

  const submissions: AgentSubmissions = {
    async pending(ctx) {
      const { harness, storage: stored } = await opened(ctx);
      const chord = toChord(ctx);
      const live: SubmissionRecord[] = [];
      for (const status of ["queued", "placed"] as const) {
        let cursor: Parameters<Storage["scanSubmissions"]>[2];
        do {
          const page = await stored.scanSubmissions({ status }, SCAN, cursor, chord);
          live.push(...page.items);
          cursor = page.next;
        } while (cursor !== undefined);
      }
      const admissions = (await harness.snapshot(AdmissionsDoc, chord))?.conversations ?? {};
      const byConversation = new Map<ConversationId, PendingConversation>();
      // By submission id, which is admission order: conversations come by their oldest pending request.
      for (const record of live.sort((a, b) => a.id - b.id)) {
        if (record.type !== "input" || record.requestId === undefined) continue;
        const ref = await refOf(record.conversationId, harness);
        if (ref === undefined) continue;
        // An admission time is written before the submit; none only if `AdmissionsDoc` lost it: now.
        const mine = admissions[String(record.conversationId)];
        const admittedAt = mine !== undefined && Object.hasOwn(mine, record.requestId) ? (mine[record.requestId] as number) : now();
        const entry = byConversation.get(record.conversationId) ?? { conversation: ref, requestIds: [], oldestAdmittedAt: admittedAt };
        entry.requestIds.push(record.requestId);
        entry.oldestAdmittedAt = Math.min(entry.oldestAdmittedAt, admittedAt);
        byConversation.set(record.conversationId, entry);
      }
      return [...byConversation.values()];
    },
    async get(conversation, requestId, ctx) {
      const id = durableId(conversation.conversationId);
      if (id === undefined) return undefined;
      const { harness, storage: stored } = await opened(ctx);
      const chord = toChord(ctx);
      const record = await stored.submissionByRequest(id, requestId, chord);
      const ref = record?.type === "input" ? await refOf(id, harness) : undefined;
      if (record === undefined || ref === undefined) return undefined;
      if (!isSettledInput(record)) return { kind: "pending", conversation: ref, requestId };
      // Its run as logged; past the log's retention (or not logged yet), its own settlement in pi-durable.
      await ready();
      const logged = await log.find(String(id), requestId);
      if (logged !== undefined) return { kind: "settled", conversation: ref, requestId, run: logged };
      const handle = await harness.conversation(id, chord);
      if (handle === undefined) return undefined;
      return { kind: "settled", conversation: ref, requestId, run: settlementOf(await toResult(handle, ref, [record], chord)) };
    },
    answers: {
      async read(after, limit) {
        await ready();
        return log.read(after, limit);
      },
    },
  };

  const runtime: DurableRuntime = {
    submissions,

    async createConversation(ctx) {
      const harness = await harnessOf(ctx);
      const chord = toChord(ctx);
      if (options.conversations === "root" && (await harness.conversation(ROOT_CONVERSATION_ID, chord)) === undefined) {
        return String((await harness.root(chord)).id);
      }
      return String((await harness.createConversation({ ownership: { kind: "ownerless" } }, chord)).id);
    },

    async dispatch(request: AgentRequest, ctx: AppContext): Promise<Admission> {
      const ref = request.conversation;
      const { requestId } = request;
      const agent = definitionOf(ref);
      const harness = await harnessOf(ctx);
      const id = conversationIdOf(ref);
      const key = keyOf(id, requestId);
      let announced!: () => void;
      const admissionAnnounced = new Promise<void>((resolve) => (announced = resolve));
      let admission: Admission;
      try {
        admission = await inLine(id, async () => {
          const conversation = await conversationOf(harness, ref, ctx);
          // One commit: the duplicate check, the agent `prepare` gives, and the admission's time.
          const existing = await conversation.commit(async (tx) => {
            const found = await tx.submissionByRequest(id, requestId);
            if (found !== undefined) return found;
            const stored = copyJson(await tx.doc(AgentStateDoc, id)) as { [key: string]: JsonValue };
            await config.apply(tx, id, ref, agent, effectiveState(agent, stored), logger);
            const admissions = await tx.doc(AdmissionsDoc);
            if (admissions.conversations[String(id)] === undefined) admissions.conversations[String(id)] = {};
            (admissions.conversations[String(id)] as { [requestId: string]: number })[requestId] = now();
            return undefined;
          }, toChord(ctx));
          refs.set(id, ref);
          if (existing !== undefined) {
            // A redelivery. Settled: its run (and every run of the conversation) may never have been
            // logged (a crash); still live: make sure something drives it.
            if (isSettledInput(existing)) {
              await reconcile(harness, id);
            } else {
              harness.resume();
              await reconcileInbox(harness, id);
            }
            return { kind: "duplicate", requestId } as const;
          }
          runs.set(key, { ctx: runContext(ctx), announced: admissionAnnounced });
          admitting.set(key, undefined);
          try {
            const whenBusy = request.whenBusy === "steer" ? ({ whenBusy: "steer" } as const) : {};
            const submission = await conversation.submit({ type: "input", content: request.prompt, requestId, ...whenBusy }, toChord(ctx));
            const status = admitting.get(key) ?? (await submission.status(toChord(ctx))).status;
            return { kind: status === "queued" ? "queued" : "started", requestId } as const;
          } catch (error) {
            runs.delete(key);
            throw error;
          } finally {
            admitting.delete(key);
          }
        });
      } catch (error) {
        announced();
        throw error;
      }
      // The run may be going already; its end is announced only after `announced()`, so
      // `agent.dispatched`, `agent.started` and its result arrive in that order.
      try {
        await ctx.emit("agent.dispatched", { conversation: ref, admission });
        if (admission.kind === "started") await emit(runContext(ctx), "agent.started", { conversation: ref, requestId, resumed: false });
      } finally {
        announced();
      }
      return admission;
    },

    async abort(conversation: ConversationRef, ctx: AppContext): Promise<void> {
      const harness = await harnessOf(ctx);
      const id = conversationIdOf(conversation);
      await inLine(id, async () => (await conversationOf(harness, conversation, ctx)).abort(toChord(ctx)));
    },

    async resume(conversation: ConversationRef, ctx: AppContext): Promise<void> {
      const harness = await harnessOf(ctx);
      const id = conversationIdOf(conversation);
      await inLine(id, async () => {
        await conversationOf(harness, conversation, ctx);
        await reconfigure(harness, id, ctx, options.agent(conversation.agent) === undefined ? undefined : conversation);
        harness.resume();
        await reconcileInbox(harness, id);
      });
    },

    async recover(conversation: ConversationRef, requestIds: readonly string[], ctx: AppContext): Promise<void> {
      let waits: Promise<void>[];
      try {
        definitionOf(conversation);
        const { harness, storage: stored } = await opened(ctx);
        const id = conversationIdOf(conversation);
        waits = await inLine(id, async () => {
          await conversationOf(harness, conversation, ctx);
          await reconfigure(harness, id, ctx, conversation);
          harness.resume();
          await reconcileInbox(harness, id);
          await reconcile(harness, id);
          const pending: Promise<void>[] = [];
          for (const requestId of requestIds) {
            const record = await stored.submissionByRequest(id, requestId, toChord(ctx));
            // Live: its settlement is handled in this line, after this step.
            if (record !== undefined && !isSettledInput(record)) pending.push(whenHandled(record.id));
          }
          return pending;
        });
      } catch (error) {
        // Retrying at every start cannot help: the user is told instead of waiting for good.
        if (error instanceof Unopenable) return runtime.abandon(conversation, requestIds, error.reason, ctx);
        throw error;
      }
      await untilAborted(Promise.all(waits), ctx.abortSignal, closedSignal);
    },

    async abandon(conversation: ConversationRef, requestIds: readonly string[], reason: string, ctx: AppContext): Promise<void> {
      const run = await abandonQueued(conversation, requestIds, reason, ctx);
      if (run === undefined) return;
      ctx.logger.warn("pending requests were abandoned unanswered; their channel tells the user", { conversation: conversation.key, requests: run.requestIds, reason });
    },

    holds(conversation: Pick<ConversationRef, "conversationId">): boolean {
      const id = Number(conversation.conversationId) as ConversationId;
      return lines.has(id) || busy.has(id) || announcing.has(id);
    },

    async whenIdle(ctx: AppContext): Promise<boolean> {
      for (;;) {
        if (closed || ctx.abortSignal?.aborted) return false;
        if (inflight.size > 0) {
          await untilAborted(Promise.allSettled([...inflight]), ctx.abortSignal, closedSignal);
          continue;
        }
        if (opening === undefined) return true;
        const harness = await opening.catch(() => undefined);
        if (harness === undefined) return !closed;
        const committed = new Promise<void>((resolve) => commitWaiters.push(resolve));
        const inspection = await harness.inspect(toChord(ctx)).catch(() => undefined);
        if (inspection === undefined) return false;
        const at = now();
        if (inflight.size === 0 && !inspection.tasks.some((task) => driven(task, at))) {
          if (options.onIdleWithPendingWork !== undefined && inspection.tasks.some((task) => timed(task, at))) {
            await options.onIdleWithPendingWork(inspection, ctx).catch(logFailure("onIdleWithPendingWork failed"));
          }
          return !closed;
        }
        await untilAborted(Promise.race([committed, ...inflight]), ctx.abortSignal, closedSignal);
      }
    },

    state: (conversation) => stateOf(conversation),

    async inspect(ctx) {
      return (await harnessOf(ctx)).inspect(toChord(ctx));
    },

    async suspend(ctx: AppContext): Promise<void> {
      if (closed || opening === undefined) return;
      await untilAborted(Promise.allSettled([...inflight]), ctx.abortSignal, closedSignal);
      const open = opening;
      if (closed || open === undefined || inflight.size > 0) return;
      opening = undefined;
      const stopping = (async () => {
        const harness = await open.catch(() => undefined);
        unsubscribe?.();
        unsubscribe = undefined;
        storage = undefined;
        // Runs waiting for a time stay pending in the storage; the next open continues them.
        if (harness !== undefined) await harness.close(toChord(ctx));
        busy.clear();
        queued.clear();
      })();
      const done: Promise<void> = stopping
        .catch(() => {})
        .then(() => {
          if (suspending === done) suspending = undefined;
        });
      suspending = done;
      await stopping;
    },

    async close(ctx: AppContext): Promise<void> {
      if (closed) return;
      closed = true;
      resolveClosed();
      for (const waiters of handled.values()) for (const wake of waiters) wake();
      handled.clear();
      await suspending;
      const open = opening;
      if (open !== undefined) {
        const harness = await open.catch(() => undefined);
        unsubscribe?.();
        // Runs in progress stop here and stay pending in the storage, for the next worker.
        if (harness !== undefined) await untilAborted(harness.close(toChord(ctx)), ctx.abortSignal);
      }
      await untilAborted(Promise.allSettled([...inflight]), ctx.abortSignal);
      storage = undefined;
      runs.clear();
    },
  };
  return runtime;
}

type Checkpoint = { phase?: string; until?: number; pollAt?: number } | undefined;

/** Live work that waits for a time, in-process: a model retry's backoff, a deferred poll, a compaction's retry. */
function timed(task: TaskInspection, at: number): boolean {
  const checkpoint = (task.record.state as { checkpoint?: Checkpoint }).checkpoint;
  if (task.record.kind === "pi.generation") {
    if (checkpoint?.phase === "retry") return (checkpoint.until ?? 0) > at;
    if (checkpoint?.phase === "poll") return (checkpoint.pollAt ?? 0) > at;
  }
  if (task.record.kind === "pi.compaction" && checkpoint?.phase === "retry") return (checkpoint.until ?? 0) > at;
  return false;
}

/** Live work this process drives now: a task running or about to, unless it only sleeps (`timed`). */
function driven(task: TaskInspection, at: number): boolean {
  return (task.state.kind === "running" || task.state.kind === "ready") && !timed(task, at);
}

/** Resolves when `work` settles, `signal` aborts, or `stop` resolves, whichever comes first. */
async function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined, stop?: Promise<void>): Promise<void> {
  const settled = work.then(
    () => {},
    () => {},
  );
  const racers: Promise<void>[] = [settled];
  if (stop !== undefined) racers.push(stop);
  let onAbort: (() => void) | undefined;
  if (signal !== undefined) {
    racers.push(
      new Promise<void>((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  await Promise.race(racers);
  if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
}
