/**
 * THROWAWAY SPIKE (ROADMAP M1, first step). Not the adapter's API.
 *
 * Proves that one pikit conversation maps onto one `AgentHarness` over one Pi session
 * (pi-agent-core 0.87.1), using only Pi's public harness API. Where Pi cannot do what pikit
 * needs, this file does NOT fill the gap; it says so, and the gap is recorded in SPEC §6.4.
 *
 * Reference: `packages/coding-agent/src/experimental/mini/worker/run.ts` in earendil-works/pi.
 */

import {
  AgentHarness,
  LaneBusy,
  operationMeta,
  value,
  withAbortSignal,
  type AgentHarnessTool,
  type AgentLane,
  type Context as PiContext,
  type JsonValue,
  type OpenOperation,
  type OperationResultRecord,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Context } from "@pikit/core";

/**
 * The one-line bridge of SPEC §6.2. Chord's `withContextValue` reads cancellation through a
 * private key, so a pikit context that Pi derives (telemetry spans, hook admission) would
 * lose its `abortSignal`. Re-attaching the signal with Chord's own `withAbortSignal` stores it
 * under that key. `withAbortSignal` here is Chord's, re-exported by pi-agent-core.
 */
export function toPi(ctx: Context): PiContext {
  const signal = ctx.abortSignal;
  return signal === undefined ? ctx : withAbortSignal(signal, ctx);
}

/** `agent.state` (SPEC §6.2a) as one session value. It resets with the session. */
const AGENT_STATE = value<JsonValue>("pikit", "agent.state");

/** A pikit conversation drives a single Pi lane. Pi's other lanes are its own transcript scopes. */
const LANE = "main";

export type Submission =
  /** `requestId` already names a run of this conversation (running or settled). */
  | { kind: "duplicate"; requestId: string; status: "running" | OperationResultRecord["status"] }
  /** The conversation was idle: a run started, with `operationId === requestId`. */
  | { kind: "started"; requestId: string; promptEntryId: string; settled: Promise<OperationResultRecord> }
  /** The conversation was busy: the message went to Pi's inbox as `steer`. */
  | { kind: "steered"; requestId: string; entryId: string };

export interface Answer {
  /** Transcript entry of the assistant message that answers. */
  entryId: string;
  text: string;
}

export interface ConversationOptions {
  session: Session;
  models: Models;
  model: Model<Api>;
  tools?: AgentHarnessTool<undefined>[];
  systemPrompt?: string;
  /** `defineAgent({ state })`: the value `agent.state` has before anything writes it. */
  initialState?: JsonValue;
}

export class SpikeConversation {
  private constructor(
    private readonly session: Session,
    private readonly harness: AgentHarness<undefined>,
    private readonly lane: AgentLane,
    private readonly initialState: JsonValue | undefined,
  ) {}

  /**
   * Open the conversation's harness. `openOperations` lists runs a previous worker left open;
   * creation restores them without starting effects (Pi's contract), and `resume()` continues
   * them.
   */
  static async open(
    options: ConversationOptions,
    ctx: Context,
  ): Promise<{ conversation: SpikeConversation; openOperations: OpenOperation[] }> {
    const pi = toPi(ctx);
    const { harness, open } = await AgentHarness.create<undefined>(
      {
        session: options.session,
        models: options.models,
        model: options.model,
        tools: options.tools ?? [],
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      },
      pi,
    );
    const lane = await harness.lane(LANE, pi);
    return {
      conversation: new SpikeConversation(options.session, harness, lane, options.initialState),
      openOperations: open,
    };
  }

  get sessionId(): string {
    return this.session.metadata.id;
  }

  /**
   * Hand one inbound message to the conversation (SPEC §7.3). Idle: start a run whose
   * `operationId` is the `requestId`. Busy: `steer`.
   *
   * Duplicates are detected only for requests that started a run, by looking the id up in Pi's
   * own operation records. Two gaps stay open, on purpose (SPEC §6.4):
   * - `accept()` does not reject a reused `operationId`, so this check-then-accept is not atomic;
   * - `steer()` takes no request id, so a repeated steered message is not recognised.
   */
  async submit(requestId: string, text: string, ctx: Context): Promise<Submission> {
    const pi = toPi(ctx);

    const settled = await this.lane.getResult(requestId, pi);
    if (settled !== undefined) return { kind: "duplicate", requestId, status: settled.status };
    const execution = await this.lane.inspectExecution(pi);
    if (execution.current?.id === requestId) return { kind: "duplicate", requestId, status: "running" };

    // Pi decides idle/busy atomically: `accept` fails with LaneBusy if a run is active.
    const admission = await this.lane.accept({ kind: "prompt", operationId: requestId, prompt: text }, pi);
    if (!admission.ok) {
      if (!LaneBusy.is(admission.error)) throw admission.error;
      const queued = await this.lane.steer(text, undefined, pi);
      if (!queued.ok) throw queued.error;
      return { kind: "steered", requestId, entryId: queued.value.entryId };
    }

    // Read before driving: Pi deletes the operation's meta when the run settles.
    const meta = await this.session.getValue(operationMeta(requestId), pi);
    const promptEntryId = meta?.value.intent.kind === "run" ? meta.value.intent.promptEntryIds[0] : undefined;
    if (promptEntryId === undefined) throw new Error(`Run ${requestId} has no prompt entry`);

    return { kind: "started", requestId, promptEntryId, settled: this.wait(requestId, ctx) };
  }

  /**
   * Wait for a run by its request id: observe it if it is running, read its record if it settled.
   * Cancelling `ctx` only stops this wait. Pi strips the caller's cancellation from the durable
   * run (`Drive` keeps `withoutAbortSignal(context)`); stopping the run is `abort()`.
   */
  async wait(requestId: string, ctx: Context): Promise<OperationResultRecord> {
    const driven = await this.lane.drive({ operationId: requestId, waitForRetry: true }, toPi(ctx));
    if (!driven.ok) throw driven.error;
    if (driven.value.kind !== "settled") throw new Error(`Run ${requestId} is waiting (${driven.value.reason})`);
    return driven.value.outcome;
  }

  /** Stop the active run now, without waiting for its tools (SPEC §7.3). Queued steers come back. */
  async abort(ctx: Context): Promise<void> {
    const aborted = await this.lane.abort(toPi(ctx));
    if (!aborted.ok) throw aborted.error;
  }

  /** Continue every operation a dead worker left open. `undefined` when there was none. */
  async resume(ctx: Context): Promise<OperationResultRecord | undefined> {
    const pi = toPi(ctx);
    if ((await this.lane.inspectExecution(pi)).current === null) return undefined;
    const result = await this.lane.resume(pi);
    if (!result.ok) throw result.error;
    if (!("kind" in result.value)) throw new Error(`Run ${result.value.operationId} suspended`);
    return result.value;
  }

  /**
   * The answer to a user message: the first assistant message after it on the branch that does
   * not call tools. A steered message and the prompt of the run it joined share that answer,
   * which is how Pi's durable runtime settles every input placed in one turn (pico-v5 §6).
   */
  async answerTo(entryId: string, ctx: Context): Promise<Answer | undefined> {
    const entries = await this.lane.findEntries({ order: "oldestFirst" }, toPi(ctx));
    const at = entries.findIndex((entry) => entry.id === entryId);
    if (at === -1) return undefined;
    for (const entry of entries.slice(at + 1)) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      if (entry.message.stopReason === "toolUse") continue;
      const text = entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      return { entryId: entry.id, text };
    }
    return undefined;
  }

  /**
   * Every run's end, whether anyone waits for it or not: a cancelled waiter and a run resumed
   * by a new worker both end here. This, not `submit`'s promise, is the source of
   * `agent.settled` (SPEC §6.1).
   */
  onRunEnd(listener: (end: { runId: string; status: "completed" | "aborted" | "failed" }) => void): () => void {
    return this.harness.events.on("run_end", (event) => listener({ runId: event.runId, status: event.status }));
  }

  /** Messages waiting in Pi's inbox (steer, follow-up, next run). */
  async queued(ctx: Context): Promise<{ entryId: string; kind: string }[]> {
    const watch = await this.lane.watch(toPi(ctx));
    watch.unsubscribe();
    return watch.snapshot.queues.map(({ entryId, kind }) => ({ entryId, kind }));
  }

  async getState(ctx: Context): Promise<JsonValue | undefined> {
    return (await this.session.getValue(AGENT_STATE, toPi(ctx)))?.value ?? this.initialState;
  }

  async setState(next: JsonValue, ctx: Context): Promise<void> {
    await this.session.setValue(AGENT_STATE, next, toPi(ctx));
  }

  /**
   * Close the harness, which also closes the session it was given (Pi's harness owns it).
   * The stored session stays: closing deactivates the actor, it never resets it. The next
   * owner reopens it from the repo.
   */
  async close(ctx: Context): Promise<void> {
    await this.harness.close(toPi(ctx));
  }
}
