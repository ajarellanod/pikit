/**
 * One pikit conversation (the actor) is one `AgentHarness` over one Pi session, driving the lane
 * "main" (SPEC §6.4). This object is the worker's cache of it: everything it knows is in the
 * session, and closing it never resets the conversation.
 *
 * Every run of the conversation is driven by this worker, whoever admitted it: a run started by a
 * `dispatch`, or a run a dead worker left open, which is resumed as soon as the conversation opens.
 * That is why a run's end always reaches `agent.settled`, with or without a caller waiting.
 */

import {
  AgentHarness,
  type AgentLane,
  LaneBusy,
  NoActiveOperation,
  type OperationResultRecord,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type { Admission, AgentDefinition, AgentRequest, AgentResult, AgentTool, AppContext, ConversationRef } from "@pikit/core";
import { detached, toPi } from "./context.ts";
import type { PiExtension } from "./extensions/api.ts";
import { type BoundExtensions, loadExtensions } from "./extensions/host.ts";
import { hasRequest, inboundMessage, LANE, recordWithdrawn } from "./inbound.ts";
import { toResult } from "./result.ts";

/** Called with each conversation's harness when it opens: where Pi hooks attach (§6.2b). */
export type HarnessHook = (harness: AgentHarness<undefined>, conversation: ConversationRef) => void;

export interface ConversationHost {
  /** Run `work` in this conversation's line: its admissions, aborts and settlements, one at a time. */
  serial<T>(work: () => Promise<T>): Promise<T>;
  /** Where a run ends up when no caller context is known. */
  events: AppContext;
}

export interface OpenOptions {
  ref: ConversationRef;
  session: Session;
  agent: AgentDefinition;
  /** Resolves the tools the agent names (`agent.tool`); a name it cannot resolve fails the open. */
  tool?: ((name: string) => AgentTool | undefined) | undefined;
  models: Models;
  host: ConversationHost;
  onHarness?: HarnessHook | undefined;
  /** Pi extensions, loaded for this conversation as Pi loads them for a session (§6.2b). */
  extensions?: readonly PiExtension[] | undefined;
}

export class PiConversation {
  /** Runs this worker is driving right now. At zero the conversation is idle and may close. */
  private driving = 0;
  private extensions: BoundExtensions | undefined;

  private constructor(
    readonly ref: ConversationRef,
    private readonly session: Session,
    private readonly harness: AgentHarness<undefined>,
    private readonly lane: AgentLane,
    private readonly host: ConversationHost,
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
    const model = resolveModel(models, agent);
    const { harness, open } = await AgentHarness.create<undefined>(
      {
        session,
        models,
        model,
        tools: [...resolveTools(agent, options.tool), ...(loaded?.tools ?? [])],
        ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
      },
      pi,
    );
    try {
      options.onHarness?.(harness, ref);
      const lane = await harness.lane(LANE, pi);
      const conversation = new PiConversation(ref, session, harness, lane, host);
      // Bound before any run is resumed, so a resumed run is seen by the extensions too.
      conversation.extensions = await loaded?.bind(
        {
          harness,
          lane,
          cwd: session.metadata.cwd ?? "/",
          systemPrompt: agent.systemPrompt,
          abort: () => host.serial(() => conversation.abort(host.events)),
        },
        pi,
      );
      const interrupted = open.find((operation) => operation.lane === LANE);
      if (interrupted !== undefined) conversation.resumeOpen(interrupted.operationId, interrupted.kind === "run", ctx);
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
   * Admit one message (SPEC §6.1): duplicate check, then enqueue as `steer`, then `accept()`. On an
   * idle lane Pi starts a run that drains the inbox; on a busy one it answers `LaneBusy` and the run
   * in progress takes the message at a boundary, the last one included (gap 2). The caller runs
   * this in the conversation's line, so two deliveries of one request never both pass the check.
   */
  async admit(request: AgentRequest, ctx: AppContext): Promise<Admission> {
    const { requestId } = request;
    const pi = toPi(ctx);
    if (await hasRequest(this.session, this.lane, requestId, pi)) return { kind: "duplicate", requestId };

    const queued = await this.lane.steer(inboundMessage(requestId, request.prompt), undefined, pi);
    if (!queued.ok) throw queued.error;

    const accepted = await this.lane.accept({ kind: "prompt", operationId: requestId, prompt: [] }, pi);
    if (!accepted.ok) {
      if (LaneBusy.is(accepted.error)) return { kind: "queued", requestId };
      throw accepted.error;
    }
    this.drive(requestId, runContext(ctx), () =>
      this.lane.drive({ operationId: requestId, waitForRetry: true }, detached(ctx)).then((driven) => {
        if (!driven.ok) throw driven.error;
        if (driven.value.kind !== "settled") return undefined;
        return driven.value.outcome;
      }),
    );
    return { kind: "started", requestId };
  }

  /**
   * Stop the active run now. Cooperative: Pi signals the running tools and waits for them. Pi takes
   * the queued messages out of the inbox; they are recorded as withdrawn (gap 4).
   */
  async abort(ctx: AppContext): Promise<void> {
    const pi = toPi(ctx);
    const aborted = await this.lane.abort(pi);
    if (!aborted.ok) {
      if (NoActiveOperation.is(aborted.error)) return;
      throw aborted.error;
    }
    await recordWithdrawn(this.lane, [...aborted.value.steer, ...aborted.value.followUp], pi);
  }

  /**
   * Close the harness, which closes the session. A run still being driven stops here and stays open
   * in the session, for the next owner to resume: eviction is never a reset.
   */
  async close(ctx: AppContext): Promise<void> {
    await this.extensions?.close(toPi(ctx));
    await this.harness.close(toPi(ctx));
  }

  private resumeOpen(operationId: string, isRun: boolean, ctx: AppContext): void {
    const runCtx = runContext(ctx);
    if (isRun) void runCtx.emit("agent.started", { conversation: this.ref, requestId: operationId, resumed: true });
    this.drive(isRun ? operationId : undefined, runCtx, () =>
      this.lane.resume(detached(ctx)).then((resumed) => {
        if (!resumed.ok) throw resumed.error;
        return "kind" in resumed.value ? resumed.value : undefined;
      }),
    );
  }

  /**
   * Drive one run in the background and report its end. The settlement runs in the conversation's
   * line, so the result is read before an idle conversation closes; the event is emitted after, so
   * slow listeners never hold admissions back.
   */
  private drive(runId: string | undefined, runCtx: AppContext, work: () => Promise<OperationResultRecord | undefined>): void {
    this.driving++;
    void work()
      .then(
        (record) => this.host.serial(() => this.settle(runId, record, runCtx)),
        (error: unknown) =>
          this.host.serial(async () => {
            this.driving--;
            // A closed harness (stop, eviction) leaves the run open for the next owner: not a failure.
            runCtx.logger.warn("a run stopped being driven; it stays open in its session", {
              conversation: this.ref.key,
              run: runId,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }),
      )
      .then((result) => {
        if (result === undefined) return;
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
    record: OperationResultRecord | undefined,
    runCtx: AppContext,
  ): Promise<AgentResult | undefined> {
    try {
      // `undefined` record: suspended on a deferred response; it stays open. No runId: not a run.
      if (record === undefined || runId === undefined) return undefined;
      return await toResult(this.lane, this.ref, record, toPi(runCtx));
    } finally {
      this.driving--;
    }
  }
}

/** A run's context: the caller's values and logger, without its cancellation (SPEC §6.1). */
export function runContext(ctx: AppContext): AppContext {
  return ctx.derive((inner) => detached(inner));
}

function resolveModel(models: Models, agent: AgentDefinition) {
  const slash = agent.model.indexOf("/");
  const model = models.getModel(agent.model.slice(0, slash), agent.model.slice(slash + 1));
  if (model === undefined) {
    throw new Error(`agent "${agent.name}": model "${agent.model}" is not provided by any model.provider`);
  }
  return model;
}

/** The agent's tools as objects: each name resolved through `agent.tool`, each object as it is. */
function resolveTools(agent: AgentDefinition, tool: ((name: string) => AgentTool | undefined) | undefined): AgentTool[] {
  return (agent.tools ?? []).map((entry) => {
    if (typeof entry !== "string") return entry;
    const resolved = tool?.(entry);
    if (resolved === undefined) throw new Error(`agent "${agent.name}" names the tool "${entry}", which no agent.tool provides`);
    return resolved;
  });
}
