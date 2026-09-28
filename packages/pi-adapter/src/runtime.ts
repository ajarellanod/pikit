/**
 * `agent.runtime` on Pi (SPEC §6.1): one worker's conversations.
 *
 * Conversations are opened on demand and closed as soon as they are idle (no run being driven), so
 * an idle conversation holds no open session (SPEC §7.1, invariant 5). Everything that touches one
 * conversation (opening, admissions, aborts, settlements, closing) runs in that conversation's
 * line, one step at a time: that is what makes the duplicate check sound (gap 1) and keeps a
 * closing harness from racing a new admission. Runs themselves execute outside the line.
 *
 * One process owns a conversation (SPEC §7.2). Several replicas need `conversations.ownership`.
 */

import type { Models } from "@earendil-works/pi-ai";
import type { AppContext, Context } from "@pikit/core";
import type {
  Admission,
  AgentDefinition,
  AgentRequest,
  AgentRuntime,
  AgentSubmissions,
  AgentTool,
  AgentResult,
  ConversationRef,
  RunSettlement,
} from "@pikit/contracts";
import { toPi } from "./context.ts";
import { type HarnessHook, PiConversation, runContext } from "./conversation.ts";
import type { PiExtension } from "./extensions/api.ts";
import type { SessionStore } from "./types.ts";

export interface PiRuntimeOptions {
  /** Where the conversations' sessions live (`sessions.store`). */
  sessions: SessionStore;
  /** The definition of an agent by name (`agent.definition`), or `undefined` if none has it. */
  agent(name: string): AgentDefinition | undefined;
  /** An installed tool by name (`agent.tool`), for the tools agents name. Without it, only tool objects work. */
  tool?(name: string): AgentTool | undefined;
  /** Every model the agents may name (`provider/modelId`). */
  models: Models;
  /**
   * Where runs report when no caller context is known. Derive it once from `start`'s context:
   * `ctx.derive(() => BACKGROUND_CONTEXT)`, never `start`'s context itself (its deadline).
   */
  events: AppContext;
  /** Attach Pi hooks to each conversation's harness when it opens (tests). */
  onHarness?: HarnessHook;
  /**
   * Pi extensions, unmodified (SPEC §6.2b), for every agent. Each conversation loads them when it
   * opens, as Pi loads them for each session, and they see every run of it.
   */
  extensions?: readonly PiExtension[];
  /**
   * An installed extension by name (`agent.extension`), for the extensions agents name. A
   * conversation loads them after `extensions`. Without it, an agent that names one cannot open.
   */
  extension?(name: string): PiExtension | undefined;
  /**
   * Where admissions and run ends are recorded (`agent.submissions`), when it is installed (SPEC §6.1).
   * `dispatch` records a message once Pi holds it and before it resolves; every run's end is recorded
   * before its `agent.settled` / `agent.failed`, and a request `abort()` withdrew as aborted. A duplicate
   * whose end it does not hold is settled from the session (two crashes lost both records). Without
   * it, nothing is recorded and the runtime behaves exactly as before.
   */
  submissions?: AgentSubmissions;
}

/** How long to wait before recording a run's end again, after `agent.submissions` failed to. */
const SETTLED_RETRY_MS = [1_000, 5_000, 30_000, 120_000] as const;

export interface PiRuntime extends AgentRuntime {
  /**
   * Open a conversation that has requests admitted and never settled (`agent.submissions`' pending),
   * as a host does at start (SPEC §7): a run a dead worker left open is resumed, messages waiting in
   * Pi's inbox get a run, and a request whose run ended but whose end was never recorded is settled
   * from the result Pi stored, with its `agent.settled` / `agent.failed` (one `agent.submissions` holds
   * settled already is skipped). Resolves once the runs opening the conversation resumed or started
   * ended (so a caller bounds how many run at once; runs of new messages are not waited for), or when
   * `ctx` is cancelled.
   */
  recover(conversation: ConversationRef, requestIds: readonly string[], ctx: AppContext): Promise<void>;
  /**
   * Close every open conversation. Runs in progress stop being driven and stay open in their
   * sessions; the next worker resumes them. Bounded by `ctx`'s cancellation.
   */
  close(ctx: AppContext): Promise<void>;
}

interface Slot {
  readonly sessionId: string;
  line: Promise<unknown>;
  /** Steps queued on `line` and not finished. At zero, with no conversation open, the slot is dropped. */
  queued: number;
  conversation?: PiConversation;
}

/** How many slots a runtime holds, for tests; not exported from the package. */
export const slotCount = new WeakMap<PiRuntime, () => number>();

export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  /** By session id: a session is Pi's single-writer unit, and a reset points a key to a new one. */
  const slots = new Map<string, Slot>();
  let closed = false;
  /** Retries of run ends `agent.submissions` failed to record; cleared on close. */
  const retries = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Records a run's end, and retries a few times in the background when that fails: until it is
   * recorded, a channel reading the answers does not see it. Given up, it stays pending, and the next
   * start settles it from the session (`recover`). Never rejects.
   */
  const recordSettled = async (run: RunSettlement, ctx: AppContext, attempt = 0): Promise<void> => {
    const submissions = options.submissions;
    if (submissions === undefined) return;
    try {
      await submissions.settled(run, ctx);
    } catch (error) {
      const wait = SETTLED_RETRY_MS[attempt];
      const fields = { conversation: run.conversation.key, run: run.requestId, error: error instanceof Error ? error.message : String(error) };
      if (closed || wait === undefined) {
        ctx.logger.error("a run's end could not be recorded in agent.submissions; the next start settles it from the session", fields);
        return;
      }
      ctx.logger.warn("recording a run's end in agent.submissions failed; trying again", { ...fields, inMs: wait });
      const timer = setTimeout(() => {
        retries.delete(timer);
        void recordSettled(run, ctx, attempt + 1);
      }, wait);
      retries.add(timer);
    }
  };

  const slotOf = (sessionId: string): Slot => {
    let slot = slots.get(sessionId);
    if (slot === undefined) {
      slot = { sessionId, line: Promise.resolve(), queued: 0 };
      slots.set(sessionId, slot);
    }
    return slot;
  };

  /**
   * Run `work` in the conversation's line, then close the conversation if it became idle. The last
   * step of a closed conversation drops its slot, so the map holds only conversations in use: a new
   * call makes a new slot, and nothing is left on the old one's line to run beside it.
   */
  const serial = <T>(slot: Slot, work: () => Promise<T>): Promise<T> => {
    slot.queued++;
    const next = slot.line.then(async () => {
      try {
        return await work();
      } finally {
        await closeIfIdle(slot);
      }
    });
    slot.line = next
      .catch(() => {})
      .then(() => {
        slot.queued--;
        if (slot.queued === 0 && slot.conversation === undefined && slots.get(slot.sessionId) === slot) slots.delete(slot.sessionId);
      });
    return next;
  };

  const closeIfIdle = async (slot: Slot): Promise<void> => {
    const conversation = slot.conversation;
    if (conversation === undefined || !conversation.idle) return;
    delete slot.conversation;
    await conversation.close(options.events).catch((error: unknown) => {
      options.events.logger.warn("closing an idle conversation failed", { conversation: conversation.ref.key, error: String(error) });
    });
  };

  const ensureOpen = async (slot: Slot, ref: ConversationRef, ctx: AppContext): Promise<PiConversation> => {
    if (closed) throw new Error("agent.runtime is closed");
    if (slot.conversation !== undefined) return slot.conversation;
    const agent = options.agent(ref.agent);
    if (agent === undefined) throw new Error(`no agent.definition "${ref.agent}" for conversation ${ref.key}`);
    // Resolved before the session opens: a name nothing provides fails the open with nothing to undo.
    const extensions = extensionsOf(agent, options);
    const session = await openSession(options.sessions, ref.sessionId, ctx);
    // `close()` may have run while this opened: what opens after it is closed at once, before
    // anything runs (`close()` waits for this line).
    if (closed) {
      await session.close(toPi(ctx)).catch(() => {});
      throw new Error("agent.runtime is closed");
    }
    const conversation = await PiConversation.open(
      {
        ref,
        session,
        agent,
        tool: options.tool,
        models: options.models,
        host: {
          serial: (work) => serial(slot, work),
          events: options.events,
          ...(options.submissions !== undefined && { settled: recordSettled }),
        },
        onHarness: options.onHarness,
        extensions,
      },
      ctx,
    );
    if (closed) {
      await conversation.close(ctx).catch(() => {});
      throw new Error("agent.runtime is closed");
    }
    slot.conversation = conversation;
    return conversation;
  };

  /**
   * Settle from the session the requests among `requestIds` whose end `agent.submissions` does not
   * hold yet (`settleFinished`). One it holds settled is skipped: its run was recorded and announced
   * already, by this process or the one before. In the conversation's line.
   */
  const settleUnrecorded = async (conversation: PiConversation, requestIds: readonly string[], ctx: AppContext): Promise<AgentResult[]> => {
    const submissions = options.submissions;
    const unrecorded: string[] = [];
    for (const requestId of requestIds) {
      if (submissions === undefined || (await submissions.get(conversation.ref, requestId, ctx))?.kind !== "settled") unrecorded.push(requestId);
    }
    return unrecorded.length === 0 ? [] : conversation.settleFinished(unrecorded, ctx);
  };

  const runtime: PiRuntime = {
    async dispatch(request: AgentRequest, ctx: AppContext): Promise<Admission> {
      const slot = slotOf(request.conversation.sessionId);
      const { admission, announced, recovered } = await serial(slot, async () => {
        const conversation = await ensureOpen(slot, request.conversation, ctx);
        const admitted = await conversation.admit(request, ctx);
        // A redelivery of a message Pi holds and `agent.submissions` may not: the process that took it
        // died before recording it, and the one that ran it died before recording its end. Its end is
        // settled here. Not `admitted`: past the provider's retention it would stay pending for good.
        const duplicate = admitted.admission.kind === "duplicate" && options.submissions !== undefined;
        return { ...admitted, recovered: duplicate ? await settleUnrecorded(conversation, [request.requestId], ctx) : [] };
      });
      // The run is already going; its end is reported only after `announced()`, so
      // `agent.dispatched`, `agent.started` and its result arrive in that order.
      let unrecorded: unknown;
      try {
        // Recorded before `dispatch` resolves, so a channel acknowledges its platform only once Pi and
        // `agent.submissions` both hold the message. Outside the line: a run that ends first has
        // settled it already, and a settled request stays settled. A failure fails the dispatch (the
        // platform delivers it again, a duplicate); the message is in Pi, and its run goes on.
        if (admission.kind !== "duplicate" && options.submissions !== undefined) {
          await options.submissions.admitted(request.conversation, request.requestId, ctx).catch((error: unknown) => {
            unrecorded = error;
          });
        }
        await ctx.emit("agent.dispatched", { conversation: request.conversation, admission });
        if (admission.kind === "started") {
          const started = { conversation: request.conversation, requestId: request.requestId, resumed: false };
          await runContext(ctx).emit("agent.started", started);
        }
        await announceEnds(recovered, ctx);
      } finally {
        announced?.();
      }
      if (unrecorded !== undefined) throw unrecorded;
      return admission;
    },

    async abort(conversation: ConversationRef, ctx: AppContext): Promise<void> {
      const slot = slotOf(conversation.sessionId);
      await serial(slot, async () => (await ensureOpen(slot, conversation, ctx)).abort(ctx));
    },

    async resume(conversation: ConversationRef, ctx: AppContext): Promise<void> {
      const slot = slotOf(conversation.sessionId);
      await serial(slot, async () => void (await ensureOpen(slot, conversation, ctx)));
    },

    async recover(conversation: ConversationRef, requestIds: readonly string[], ctx: AppContext): Promise<void> {
      const slot = slotOf(conversation.sessionId);
      const { ended, results } = await serial(slot, async () => {
        const wasOpen = slot.conversation !== undefined;
        const opened = await ensureOpen(slot, conversation, ctx);
        // Only the runs opening it started (one a dead worker left open, one for its inbox): the runs of
        // messages that arrive meanwhile, or of a conversation already open, are not recover's to wait for.
        const ended = wasOpen ? Promise.resolve() : opened.runsEnded();
        return { ended, results: await settleUnrecorded(opened, requestIds, ctx) };
      });
      await announceEnds(results, ctx);
      await untilAborted(ended, ctx.abortSignal);
    },

    async close(ctx: AppContext): Promise<void> {
      closed = true;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      const open = [...slots.values()].flatMap((slot) => {
        const conversation = slot.conversation;
        if (conversation === undefined) return [];
        delete slot.conversation;
        return [conversation.close(ctx)];
      });
      // And the steps in the lines: a conversation still opening closes itself there (`ensureOpen`),
      // so none is left open, driving a run, after this returns.
      const lines = [...slots.values()].map((slot) => slot.line);
      await untilAborted(Promise.allSettled([...open, ...lines]), ctx.abortSignal);
    },
  };
  slotCount.set(runtime, () => slots.size);
  return runtime;
}

/**
 * Announce the ends of runs settled from the session: the process that drove them died before it
 * did. No `agent.started` precedes them, since that process announced it.
 */
async function announceEnds(results: readonly AgentResult[], ctx: AppContext): Promise<void> {
  const events = runContext(ctx);
  for (const result of results) {
    if (result.kind === "failed") await events.emit("agent.failed", { ...result, kind: "failed" });
    else await events.emit("agent.settled", { ...result, kind: result.kind });
  }
}

/** Resolves when `work` settles or `signal` aborts, whichever comes first. */
async function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  const settled = work.then(
    () => {},
    () => {},
  );
  if (signal === undefined) return settled;
  let onAbort: (() => void) | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      onAbort = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
}

/**
 * The extensions a conversation of `agent` loads: the runtime's, then the ones the agent names, in
 * that order. A factory in both lists loads once, where it first appears. The agent of a conversation
 * is fixed while it is open, so this is decided once, when it opens.
 */
function extensionsOf(agent: AgentDefinition, options: PiRuntimeOptions): PiExtension[] {
  const named = (agent.extensions ?? []).map((name) => {
    const extension = options.extension?.(name);
    if (extension === undefined) throw new Error(`agent "${agent.name}" names the extension "${name}", which no agent.extension provides`);
    return extension;
  });
  return [...new Set([...(options.extensions ?? []), ...named])];
}

/**
 * Pi's repos open a session from its metadata, and the conversation knows only its id. A store with
 * `find` looks it up (`sessions-jsonl` keeps an index); any other store is listed, which reads every
 * session it holds, on every conversation opened.
 */
async function openSession(sessions: SessionStore, sessionId: string, ctx: Context) {
  const pi = toPi(ctx);
  const metadata =
    sessions.find !== undefined
      ? await sessions.find(sessionId, pi)
      : (await sessions.list(undefined, pi)).find((candidate: { id: string }) => candidate.id === sessionId);
  if (metadata === undefined) throw new Error(`session ${sessionId} not found in sessions.store`);
  return sessions.open(metadata, pi);
}
