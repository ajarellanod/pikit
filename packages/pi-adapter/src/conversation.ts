/**
 * One pikit conversation (the actor) is one `AgentHarness` over one Pi session, driving the lane
 * "main" (features/pi-durable-migration.md). This object is the worker's cache of it: everything
 * it knows is in the session, and closing it never resets the conversation.
 *
 * Every run of the conversation is driven by this worker, whoever admitted it: a run started by a
 * `dispatch`, a run a dead worker left open, which is resumed as soon as the conversation opens, or
 * a run started for the messages another run left in Pi's inbox (`reconcile`).
 * That is why a run's end always reaches `agent.settled`, with or without a caller waiting.
 *
 * Every run's context carries the conversation (`CONVERSATION`) and its `agent.state` (`AGENT_STATE`),
 * and Pi hands that context to each tool call: that is how a tool knows the conversation it runs in
 * (a `workspace` picks the agent's directory from it) and reaches its state.
 */

import {
  AgentHarness,
  type AgentLane,
  type Context as PiContext,
  LaneBusy,
  NoActiveOperation,
  type OperationResultRecord,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { type AppContext, type Context, withContextValue } from "@pikit/core";
import {
  type Admission,
  AGENT_STATE,
  type AgentDefinition,
  type AgentRequest,
  type AgentResult,
  type AgentState,
  type AgentTool,
  CONVERSATION,
  type ConversationRef,
  type RunSettlement,
} from "@pikit/contracts";
import { detached, toPi } from "./context.ts";
import type { PiExtension } from "./extensions/api.ts";
import { type BoundExtensions, loadExtensions } from "./extensions/host.ts";
import { hasRequest, inboundMessage, inInbox, LANE, queuedRequest, recordWithdrawn, requestsBefore, withdrawnWith } from "./inbound.ts";
import { settlementOf, toResult } from "./result.ts";
import { sessionState } from "./state.ts";
import { Turns } from "./turns.ts";

/** Called with each conversation's harness when it opens: where Pi hooks attach. */
export type HarnessHook = (harness: AgentHarness<undefined>, conversation: ConversationRef) => void;

export interface ConversationHost {
  /** Run `work` in this conversation's line: its admissions, aborts and settlements, one at a time. */
  serial<T>(work: () => Promise<T>): Promise<T>;
  /** Where a run ends up when no caller context is known. */
  events: AppContext;
  /**
   * Records that a run ended, with `agent.submissions` installed (@pikit/contracts'
   * submissions.ts). Never rejects: a failure is the host's to retry and log. Called in the
   * conversation's line, before the run's event.
   */
  settled?(run: RunSettlement, ctx: AppContext): Promise<void>;
  /**
   * Continues runs past Pi's backoff from outside this process (`PiRuntimeOptions.retryAt`). Present:
   * a run that must wait before retrying a model call stops being driven there, and this is told when
   * the retry is due (epoch ms, Pi's clock). Absent: the run waits in this process.
   */
  retryAt?(notBefore: number, ctx: AppContext): Promise<void>;
}

/** What driving an operation returns when it stopped at a retry wait the host continues (`retryAt`). */
const RETRY_WAIT = Symbol("retry wait");

export interface OpenOptions {
  ref: ConversationRef;
  session: Session;
  agent: AgentDefinition;
  /** Resolves the tools the agent names (`agent.tool`); a name it cannot resolve fails the open. */
  tool?: ((name: string) => AgentTool | undefined) | undefined;
  models: Models;
  host: ConversationHost;
  onHarness?: HarnessHook | undefined;
  /** Pi extensions, loaded for this conversation as Pi loads them for a session. */
  extensions?: readonly PiExtension[] | undefined;
}

/** What `admit` did, and for a run it started, how the caller lets that run report its end. */
export interface Admitted {
  admission: Admission;
  /**
   * Call once `agent.started` is emitted. The run is already going; only the event of its end waits
   * for this, so `agent.started` always comes first. Present when `admission` is `started`.
   */
  announced?: () => void;
}

export class PiConversation {
  /** Runs this worker is driving right now. At zero the conversation is idle and may close. */
  private driving = 0;
  /** The ids of the runs among them; their ends are reported by `drive`. */
  private readonly runs = new Set<string>();
  /** One per run being driven: resolved once its end is handled, or the conversation closed (`runsEnded`). */
  private readonly ending = new Map<Promise<void>, () => void>();
  private closed = false;
  private extensions: BoundExtensions | undefined;

  private constructor(
    readonly ref: ConversationRef,
    private readonly session: Session,
    private readonly harness: AgentHarness<undefined>,
    private readonly lane: AgentLane,
    private readonly host: ConversationHost,
    private readonly state: AgentState,
  ) {}

  /** Open the harness and continue the run a dead worker left open, if there is one. */
  static async open(options: OpenOptions, ctx: AppContext): Promise<PiConversation> {
    const { ref, session, agent, models, host } = options;
    const pi = toPi(ctx);
    // Extensions load first: their tools and providers belong in the harness from the start.
    const loaded =
      options.extensions !== undefined && options.extensions.length > 0
        ? await loadExtensions(options.extensions, { models, logger: ctx.logger })
        : undefined;
    const state = sessionState(session, agent.state);
    const source = { agent, models, tool: options.tool, extensionTools: loaded?.tools ?? [] };
    const turns = new Turns(source, ref, state, ctx.logger);
    const { harness, open } = await AgentHarness.create<undefined>(
      {
        session,
        models,
        model: turns.initial.model,
        tools: turns.tools,
        // Read for every model call: the prompt `prepare` chose for the run, or the static one.
        systemPrompt: () => turns.systemPrompt ?? "",
      },
      pi,
    );
    try {
      options.onHarness?.(harness, ref);
      const lane = await harness.lane(LANE, pi);
      const conversation = new PiConversation(ref, session, harness, lane, host, state);
      if (agent.prepare !== undefined) {
        // Registered before the extensions bind, so their `before_agent_start` sees the prepared prompt.
        harness.hooks.on("before_run", async (_event, hookCtx) => {
          await turns.prepareRun(harness, lane, hookCtx).catch((error: unknown) => {
            ctx.logger.error("preparing a run failed", { conversation: ref.key, error: String(error) });
          });
          return undefined;
        });
      }
      const interrupted = open.find((operation) => operation.lane === LANE);
      // Pi runs `before_run` only when a run starts: a resumed run is prepared here (see turns.ts),
      // before the extensions bind, so they start from the tools it was prepared with.
      if (interrupted?.kind === "run" && agent.prepare !== undefined) await turns.prepareRun(harness, lane, pi);
      // Bound before any run is resumed, so a resumed run is seen by the extensions too.
      conversation.extensions = await loaded?.bind(
        {
          harness,
          lane,
          cwd: session.metadata.cwd ?? "/",
          get systemPrompt() {
            return turns.systemPrompt;
          },
          abort: () => host.serial(() => conversation.abort(host.events)),
        },
        pi,
      );
      if (interrupted !== undefined) conversation.resumeOpen(interrupted.operationId, interrupted.kind === "run", ctx);
      // A message a dead worker queued and never started (it died between `steer` and `accept`).
      else await conversation.reconcile(ctx);
      return conversation;
    } catch (error) {
      await harness.close(pi).catch(() => {});
      throw error;
    }
  }

  get idle(): boolean {
    return this.driving === 0;
  }

  /**
   * Admit one message (`dispatch`, @pikit/contracts' agent.ts): duplicate check, then enqueue as
   * `steer`, then `accept()`. On an idle lane Pi starts a run that drains the inbox; on a busy one
   * it answers `LaneBusy` and the run in progress takes the message at a boundary. A message that
   * run does not take (it failed, or the message landed after its last boundary: gap 2) gets the
   * next run from `reconcile`. The caller runs this in the conversation's line, so two deliveries
   * of one request never both pass the check.
   */
  async admit(request: AgentRequest, ctx: AppContext): Promise<Admitted> {
    const { requestId } = request;
    const pi = toPi(ctx);
    if (await hasRequest(this.session, this.lane, requestId, pi)) {
      // It may be a duplicate only because it waits in the inbox with no run to take it.
      await this.reconcile(ctx);
      return { admission: { kind: "duplicate", requestId } };
    }

    const queued = await this.lane.steer(inboundMessage(requestId, request.prompt), undefined, pi);
    if (!queued.ok) throw queued.error;

    const accepted = await this.lane.accept({ kind: "prompt", operationId: requestId, prompt: [] }, pi);
    if (!accepted.ok) {
      if (LaneBusy.is(accepted.error)) return { admission: { kind: "queued", requestId } };
      throw accepted.error;
    }
    let announced!: () => void;
    const started = new Promise<void>((resolve) => (announced = resolve));
    this.driveAccepted(requestId, ctx, started);
    return { admission: { kind: "started", requestId }, announced };
  }

  /** Drive the run `accept()` just started as `operationId`; its end is reported after `started`. */
  private driveAccepted(operationId: string, ctx: AppContext, started: Promise<void>): void {
    this.drive(operationId, runContext(ctx), () => this.driveOperation(operationId, false, ctx), started);
  }

  /**
   * Drive one operation of the lane until it ends (its result record), or until it waits: on a deferred
   * response (`undefined`: it stays open), or, when the host continues runs itself (`retryAt`), before
   * Pi retries a model call (`RETRY_WAIT`: it stays open, and the host was told when). Without
   * `retryAt`, Pi waits out its backoff here, in this process.
   */
  private async driveOperation(
    operationId: string,
    pollDeferred: boolean,
    ctx: AppContext,
  ): Promise<OperationResultRecord | typeof RETRY_WAIT | undefined> {
    const retryAt = this.host.retryAt;
    const driven = await this.lane.drive(
      { operationId, waitForRetry: retryAt === undefined, ...(pollDeferred && { pollDeferred }) },
      this.runScope(ctx),
    );
    if (!driven.ok) throw driven.error;
    const outcome = driven.value;
    if (outcome.kind === "settled") return outcome.outcome;
    if (outcome.reason !== "retry" || retryAt === undefined) return undefined;
    await retryAt(outcome.notBefore, runContext(ctx));
    return RETRY_WAIT;
  }

  /**
   * Start a run for the inbound messages waiting in Pi's inbox when no run is going to take them
   * (`pi-gaps.test.ts`, gap 2). Pi 0.99.0 leaves the inbox as it is when a run ends: a message
   * queued behind a run that failed, or steered after the run's last boundary, or steered by a
   * worker that died before its `accept()`, would wait for the next message. `accept()` with an
   * empty prompt takes them out of the inbox into the new run, which is named after the oldest one
   * and answers them all (`AgentResult.requestIds`). Nothing is queued here: this only asks Pi's
   * inbox. A run that fails again cannot loop, since its messages are in the transcript by then, no
   * longer in the inbox. Called in the conversation's line.
   */
  private async reconcile(ctx: AppContext): Promise<void> {
    if (this.closed) return;
    const pi = toPi(ctx);
    const requestId = await queuedRequest(this.session, pi);
    if (requestId === undefined) return;
    const accepted = await this.lane.accept({ kind: "prompt", operationId: requestId, prompt: [] }, pi);
    if (!accepted.ok) {
      // A run is going: it takes the messages at a boundary, and this runs again when it ends.
      if (LaneBusy.is(accepted.error)) return;
      throw accepted.error;
    }
    const started = runContext(ctx).emit("agent.started", { conversation: this.ref, requestId, resumed: false });
    this.driveAccepted(requestId, ctx, started);
  }

  /**
   * Stop the active run now. Cooperative: Pi signals the running tools and waits for them. Pi takes
   * the queued messages out of the inbox; they are recorded as withdrawn (gap 4).
   */
  async abort(ctx: AppContext): Promise<void> {
    // An extension's `ctx.abort()` can reach the line after the conversation closed (host.ts): a
    // closed conversation drives no run, so there is nothing to stop.
    if (this.closed) return;
    const pi = toPi(ctx);
    const aborted = await this.lane.abort(pi);
    if (!aborted.ok) {
      if (NoActiveOperation.is(aborted.error)) return;
      throw aborted.error;
    }
    const withdrawn = await recordWithdrawn(this.lane, [...aborted.value.steer, ...aborted.value.followUp], pi);
    // Withdrawn requests end unanswered, as Pi's durable runtime records them: settled as aborted, in
    // a settlement of their own, since the aborted run did not take them.
    const [first] = withdrawn;
    if (first !== undefined) await this.host.settled?.({ conversation: this.ref, requestId: first, requestIds: withdrawn, kind: "aborted" }, ctx);
  }

  /**
   * Settle, from what Pi stored, the requests among `requestIds` that ended and were never reported:
   * the process died between Pi's commit and the record in `agent.submissions`. A request ended when
   * the run that took it ended (Pi stored its result), or when an abort withdrew it (settled aborted,
   * with the others it withdrew, as `abort()` settles them). A request a run of this worker is driving,
   * or waiting in the inbox, is left to that run. Returns the results of the runs it settled, for the
   * caller to announce. Called in the conversation's line, once it is open (a run a dead worker left
   * open is being resumed by then, and the inbox reconciled). Settling again is harmless: idempotent.
   */
  async settleFinished(requestIds: readonly string[], ctx: AppContext): Promise<AgentResult[]> {
    const pi = toPi(ctx);
    const results: AgentResult[] = [];
    const withdrawnSettled = new Set<string>();
    const stuck: string[] = [];
    for (const requestId of requestIds) {
      if (this.runs.has(requestId) || withdrawnSettled.has(requestId) || results.some((result) => result.requestIds.includes(requestId))) {
        continue;
      }
      if (await inInbox(this.session, requestId, pi)) continue;
      const result = await this.resultOfRunThatTook(requestId, pi);
      if (result !== undefined) {
        await this.host.settled?.(settlementOf(result), ctx);
        results.push(result);
        continue;
      }
      const withdrawn = await withdrawnWith(this.lane, requestId, pi);
      const [first] = withdrawn ?? [];
      if (withdrawn !== undefined && first !== undefined) {
        await this.host.settled?.({ conversation: this.ref, requestId: first, requestIds: withdrawn, kind: "aborted" }, ctx);
        for (const id of withdrawn) withdrawnSettled.add(id);
        continue;
      }
      stuck.push(requestId);
    }
    if (stuck.length > 0 && this.idle) {
      // No run is going to settle them: not in the inbox, not open, no result of their own. They stay
      // pending, and are looked at again at the next start.
      ctx.logger.warn("pending requests have no run to settle them; their answers, if any, are in the session", {
        conversation: this.ref.key,
        requests: stuck,
      });
    }
    return results;
  }

  /**
   * The ended result of the run that took `requestId`, if that run ended. Pi stores a result under the
   * run's operation id, which is its first request's id; a request steered into a run in progress has
   * none of its own, and belongs to the nearest run named after a message before it, if that run's
   * requests include it. Bounded by the window of the duplicate check.
   */
  private async resultOfRunThatTook(requestId: string, pi: PiContext): Promise<AgentResult | undefined> {
    let record = await this.lane.getResult(requestId, pi);
    if (record === undefined) {
      for (const before of await requestsBefore(this.lane, requestId, pi)) {
        record = await this.lane.getResult(before, pi);
        if (record !== undefined) break;
      }
    }
    if (record === undefined) return undefined;
    const result = await toResult(this.lane, this.ref, record, pi);
    // The nearest ended run did not take it: a run still open did, and reports it when it ends.
    return result.requestIds.includes(requestId) ? result : undefined;
  }

  /**
   * Resolves once the runs this worker is driving now have ended (and started one for what they left
   * in the inbox), or the conversation closed. Runs started later are not waited for.
   */
  runsEnded(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return Promise.all(this.ending.keys()).then(() => {});
  }

  /**
   * Close the harness, which closes the session. A run still being driven stops here and stays open
   * in the session, for the next owner to resume: eviction is never a reset.
   */
  async close(ctx: AppContext): Promise<void> {
    this.closed = true;
    for (const resolve of this.ending.values()) resolve();
    this.ending.clear();
    await this.extensions?.close(toPi(ctx));
    await this.harness.close(toPi(ctx));
  }

  /**
   * Continue the operation a dead worker left open, or one left at a retry wait (`retryAt`): each time
   * the conversation opens with it, so its `agent.started` (`resumed`) may be announced more than once.
   */
  private resumeOpen(operationId: string, isRun: boolean, ctx: AppContext): void {
    const runCtx = runContext(ctx);
    const started = isRun ? runCtx.emit("agent.started", { conversation: this.ref, requestId: operationId, resumed: true }) : undefined;
    this.drive(
      isRun ? operationId : undefined,
      runCtx,
      () =>
        // Pi's `resume()` waits out a retry in this process; with `retryAt` the lane is driven directly.
        this.host.retryAt !== undefined
          ? this.driveOperation(operationId, true, ctx)
          : this.lane.resume(this.runScope(ctx)).then((resumed) => {
              if (!resumed.ok) throw resumed.error;
              return "kind" in resumed.value ? resumed.value : undefined;
            }),
      started,
    );
  }

  /** The context a run is driven in: the caller's values, no cancellation, the conversation and its state. */
  private runScope(ctx: AppContext): Context {
    return withContextValue(CONVERSATION, this.ref, withContextValue(AGENT_STATE, this.state, detached(ctx)));
  }

  /**
   * Drive one run in the background and report its end. The settlement runs in the conversation's
   * line, so the result is read before an idle conversation closes; the event is emitted after, so
   * slow listeners never hold admissions back, and after `started` (the run's `agent.started`).
   */
  private drive(
    runId: string | undefined,
    runCtx: AppContext,
    work: () => Promise<OperationResultRecord | typeof RETRY_WAIT | undefined>,
    started: Promise<void> = Promise.resolve(),
  ): void {
    this.driving++;
    if (runId !== undefined) this.runs.add(runId);
    let resolveEnd!: () => void;
    const end = new Promise<void>((resolve) => (resolveEnd = resolve));
    this.ending.set(end, resolveEnd);
    const ended = () => {
      this.ending.delete(end);
      resolveEnd();
    };
    void work()
      .then(
        (record) => this.host.serial(() => this.settle(runId, record, runCtx, ended)),
        (error: unknown) =>
          this.host.serial(async () => {
            this.driving--;
            if (runId !== undefined) this.runs.delete(runId);
            ended();
            // A closed harness (stop, eviction) leaves the run open for the next owner: not a failure.
            runCtx.logger.warn("a run stopped being driven; it stays open in its session", {
              conversation: this.ref.key,
              run: runId,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }),
      )
      .then(async (result) => {
        if (result === undefined) return;
        await started;
        if (result.kind === "failed") void runCtx.emit("agent.failed", { ...result, kind: "failed" });
        else void runCtx.emit("agent.settled", { ...result, kind: result.kind });
      })
      .catch((error: unknown) => {
        // Reading the result failed (the harness closed under it): the run's end is in the session.
        runCtx.logger.error("a run ended but its result could not be read", {
          conversation: this.ref.key,
          run: runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async settle(
    runId: string | undefined,
    driven: OperationResultRecord | typeof RETRY_WAIT | undefined,
    runCtx: AppContext,
    ended: () => void,
  ): Promise<AgentResult | undefined> {
    try {
      // At a retry wait the host continues, the run stays open, unless an `abort()` in the line before
      // this step ended it: nothing else drives it, so its result is reported here.
      const record = driven === RETRY_WAIT ? (runId === undefined ? undefined : await this.lane.getResult(runId, toPi(runCtx))) : driven;
      // `undefined` record: suspended on a deferred response, or waiting for a retry; it stays open. No runId: not a run.
      if (record === undefined || runId === undefined) return undefined;
      const result = await toResult(this.lane, this.ref, record, toPi(runCtx));
      // Before the event: a channel the event wakes reads it from `agent.submissions`' answers.
      await this.host.settled?.(settlementOf(result), runCtx);
      return result;
    } finally {
      this.driving--;
      if (runId !== undefined) this.runs.delete(runId);
      // Before the line sees the conversation idle and closes it: what this run left in the inbox.
      await this.reconcile(this.host.events).catch((error: unknown) => {
        this.host.events.logger.error("starting a run for queued messages failed; they wait for the next one", {
          conversation: this.ref.key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      ended();
    }
  }
}

/** A run's context: the caller's values and logger, without its cancellation. */
export function runContext(ctx: AppContext): AppContext {
  return ctx.derive((inner) => detached(inner));
}

