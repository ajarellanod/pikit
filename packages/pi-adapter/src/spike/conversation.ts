/**
 * THROWAWAY SPIKE (ROADMAP M1, first step). Not the adapter's API.
 *
 * Proves that one pikit conversation maps onto one `AgentHarness` over one Pi session
 * (pi-agent-core 0.87.1), using only Pi's public harness API. The admission follows the
 * semantics of a submission in Pi's durable runtime (pico-v5 §6), built from mechanisms Pi
 * already has; it is deleted when the adapter moves to `pi-durable` (SPEC §6.4).
 *
 * Reference: `packages/coding-agent/src/experimental/mini/worker/run.ts` in earendil-works/pi.
 */

import {
  AgentHarness,
  createCustomMessage,
  LaneBusy,
  laneState,
  pendingEntry,
  value,
  withAbortSignal,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type Context as PiContext,
  type Entry,
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

/**
 * Inbound messages are Pi `custom` messages (`createCustomMessage`), so the request id is
 * committed with the message itself, in Pi's inbox and then in the transcript. Pi's default
 * `convertToLlm` turns them into user messages for the model.
 */
const INBOUND = "pikit.inbound";

export type Submission =
  /** This conversation already has `requestId`, waiting in the inbox or in the transcript. */
  | { kind: "duplicate"; requestId: string; where: "queued" | "transcript" }
  /** The conversation was idle: a run started, with `operationId === requestId`. */
  | { kind: "started"; requestId: string; entryId: string; settled: Promise<OperationResultRecord> }
  /** The conversation was busy: the message waits in Pi's inbox as `steer`. */
  | { kind: "queued"; requestId: string; entryId: string };

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

function requestIdOf(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== INBOUND) return undefined;
  const details = message.details as { requestId?: unknown } | undefined;
  return typeof details?.requestId === "string" ? details.requestId : undefined;
}

function isRequest(entry: Entry, requestId: string): boolean {
  return entry.type === "message" && requestIdOf(entry.message) === requestId;
}

export class SpikeConversation {
  /** Orders the admissions of this worker; holds no message (see `submit`). */
  private admission: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly session: Session,
    private readonly harness: AgentHarness<undefined>,
    private readonly lane: AgentLane,
    private readonly initialState: JsonValue | undefined,
  ) {}

  /**
   * Open the conversation's harness. `openOperations` lists runs a previous worker left open;
   * creation restores them without starting effects (Pi's contract), and `resume()` continues
   * them. `harness` is returned for tests only.
   */
  static async open(
    options: ConversationOptions,
    ctx: Context,
  ): Promise<{ conversation: SpikeConversation; openOperations: OpenOperation[]; harness: AgentHarness<undefined> }> {
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
      harness,
    };
  }

  get sessionId(): string {
    return this.session.metadata.id;
  }

  /**
   * Hand one inbound message to the conversation (SPEC §6.1), in the order Pi's durable runtime
   * uses for a submission:
   *
   * 1. Duplicate check: the request id is looked up in Pi's inbox and transcript.
   * 2. Enqueue first: the message becomes durable in Pi's inbox, carrying its request id.
   * 3. Then start a run if the conversation is idle. `accept()` drains Pi's inbox into the new
   *    run; if a run is active it fails with `LaneBusy`, and that run's next boundary takes the
   *    message. Its final boundary re-reads the inbox inside its own commit, so a message
   *    enqueued before that commit is never left behind (SPEC §6.4, gap 2).
   *
   * Admissions of one conversation run one at a time in this worker, so two deliveries of the
   * same request cannot both pass step 1 (gap 1). One worker owns a conversation (§7.2).
   */
  submit(requestId: string, text: string, ctx: Context): Promise<Submission> {
    const next = this.admission.then(() => this.admit(requestId, text, ctx));
    this.admission = next.catch(() => {});
    return next;
  }

  private async admit(requestId: string, text: string, ctx: Context): Promise<Submission> {
    const pi = toPi(ctx);
    const seen = await this.find(requestId, pi);
    if (seen !== undefined) return { kind: "duplicate", requestId, where: seen };

    const message = createCustomMessage(INBOUND, text, true, { requestId }, Date.now());
    const queued = await this.lane.steer(message, undefined, pi);
    if (!queued.ok) throw queued.error;
    const { entryId } = queued.value;

    const admission = await this.lane.accept({ kind: "prompt", operationId: requestId, prompt: [] }, pi);
    if (!admission.ok) {
      if (!LaneBusy.is(admission.error)) throw admission.error;
      return { kind: "queued", requestId, entryId };
    }
    return { kind: "started", requestId, entryId, settled: this.wait(requestId, ctx) };
  }

  /**
   * Where Pi holds `requestId`, if anywhere. The inbox is read from Pi's own lane records; the
   * transcript is scanned whole, which a real adapter bounds to a redelivery window.
   */
  private async find(requestId: string, pi: PiContext): Promise<"queued" | "transcript" | undefined> {
    const lane = await this.session.getValue(laneState(LANE), pi);
    for (const item of lane?.value.inbox ?? []) {
      const pending = await this.session.getValue(pendingEntry(item.entryId), pi);
      if (pending?.value.type === "message" && requestIdOf(pending.value.payload) === requestId) return "queued";
    }
    const entries = await this.lane.findEntries({ type: "message", order: "newestFirst" }, pi);
    return entries.some((entry) => isRequest(entry, requestId)) ? "transcript" : undefined;
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

  /** Stop the active run now, without waiting for the model (SPEC §7.3). Queued steers come back. */
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
   * The answer to a request: the first assistant message after it on the branch that does not
   * call tools. A queued message and the prompt of the run it joined share that answer, which
   * is how Pi's durable runtime settles every input placed in one turn (pico-v5 §6). It reads
   * the transcript, so it works in any worker, after a crash too.
   */
  async answerTo(requestId: string, ctx: Context): Promise<Answer | undefined> {
    const entries = await this.lane.findEntries({ order: "oldestFirst" }, toPi(ctx));
    const at = entries.findIndex((entry) => isRequest(entry, requestId));
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
    const lane = await this.session.getValue(laneState(LANE), toPi(ctx));
    return (lane?.value.inbox ?? []).map(({ entryId, kind }) => ({ entryId, kind }));
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
