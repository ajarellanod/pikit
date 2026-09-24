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
import type { Admission, AgentDefinition, AgentRequest, AgentRuntime, AgentTool, AppContext, Context, ConversationRef } from "@pikit/core";
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
   * Pi extensions, unmodified (SPEC §6.2b). Each conversation loads them when it opens, as Pi loads
   * them for each session, and they see every run of it.
   */
  extensions?: readonly PiExtension[];
}

export interface PiRuntime extends AgentRuntime {
  /**
   * Close every open conversation. Runs in progress stop being driven and stay open in their
   * sessions; the next worker resumes them. Bounded by `ctx`'s cancellation.
   */
  close(ctx: AppContext): Promise<void>;
}

interface Slot {
  line: Promise<unknown>;
  conversation?: PiConversation;
}

export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  /** By session id: a session is Pi's single-writer unit, and a reset points a key to a new one. */
  const slots = new Map<string, Slot>();
  let closed = false;

  const slotOf = (sessionId: string): Slot => {
    let slot = slots.get(sessionId);
    if (slot === undefined) {
      slot = { line: Promise.resolve() };
      slots.set(sessionId, slot);
    }
    return slot;
  };

  /** Run `work` in the conversation's line, then close the conversation if it became idle. */
  const serial = <T>(slot: Slot, work: () => Promise<T>): Promise<T> => {
    const next = slot.line.then(async () => {
      try {
        return await work();
      } finally {
        await closeIfIdle(slot);
      }
    });
    slot.line = next.catch(() => {});
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
    const session = await openSession(options.sessions, ref.sessionId, ctx);
    const conversation = await PiConversation.open(
      {
        ref,
        session,
        agent,
        tool: options.tool,
        models: options.models,
        host: { serial: (work) => serial(slot, work), events: options.events },
        onHarness: options.onHarness,
        extensions: options.extensions,
      },
      ctx,
    );
    slot.conversation = conversation;
    return conversation;
  };

  return {
    async dispatch(request: AgentRequest, ctx: AppContext): Promise<Admission> {
      const slot = slotOf(request.conversation.sessionId);
      const admission = await serial(slot, async () => (await ensureOpen(slot, request.conversation, ctx)).admit(request, ctx));
      await ctx.emit("agent.dispatched", { conversation: request.conversation, admission });
      if (admission.kind === "started") {
        const started = { conversation: request.conversation, requestId: request.requestId, resumed: false };
        await runContext(ctx).emit("agent.started", started);
      }
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

    async close(ctx: AppContext): Promise<void> {
      closed = true;
      const open = [...slots.values()].flatMap((slot) => {
        const conversation = slot.conversation;
        if (conversation === undefined) return [];
        delete slot.conversation;
        return [conversation.close(ctx)];
      });
      const all = Promise.allSettled(open);
      const signal = ctx.abortSignal;
      if (signal === undefined) {
        await all;
        return;
      }
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    },
  };
}

/**
 * Pi's repos open a session from its metadata, and the conversation knows only its id. Listing is
 * what the store offers; a registry that keeps the metadata can remove the scan.
 */
async function openSession(sessions: SessionStore, sessionId: string, ctx: Context) {
  const pi = toPi(ctx);
  const metadata = (await sessions.list(undefined, pi)).find((candidate: { id: string }) => candidate.id === sessionId);
  if (metadata === undefined) throw new Error(`session ${sessionId} not found in sessions.store`);
  return sessions.open(metadata, pi);
}
