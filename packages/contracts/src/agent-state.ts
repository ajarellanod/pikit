/**
 * `agent.state`: the per-conversation JSON document an agent's `prepare(state)` reads
 * and its tools update. It lives in the runtime's conversation (a pi-durable document), so it commits with it,
 * survives restarts and eviction, and starts fresh after a reset (a new conversation). The runtime
 * provides it; pikit keeps no store of its own.
 *
 * A tool reaches the state of the conversation it runs in through its context, not through a
 * global or a capability: the runtime puts the conversation's `AgentState` in the context of every
 * run, and pi-durable hands that context to each tool call.
 *
 *   const state = context.value(AGENT_STATE);
 *   await state?.update({ phase: "deploying" }, context);
 *
 * A context value rather than a capability because a tool has no `ConversationRef` of its own, and
 * a project's tool objects are not components: they cannot `use()` anything. The value is scoped to
 * one run of one conversation, so a tool can never touch another conversation's state.
 */

import { type Context, type ContextKey, createContextKey } from "@pikit/core";

export interface AgentState<S extends object = Record<string, unknown>> {
  /** The state now: the agent's initial state with every committed update merged over it. A copy. */
  get(ctx: Context): Promise<S>;
  /**
   * Merge `patch` into the state, key by key (a shallow merge; `null` is a value, not a deletion),
   * and commit it. Resolves with the new state once it is durable. Updates of one conversation apply
   * one at a time, in call order, so concurrent tools never lose each other's keys. A patch that is
   * not JSON (a function, `undefined`, `NaN`, a class instance) is rejected and changes nothing.
   */
  update(patch: Partial<S>, ctx: Context): Promise<S>;
}

/** Where a run's context carries its conversation's `AgentState`. */
export const AGENT_STATE: ContextKey<AgentState> = createContextKey<AgentState>("pikit.agent.state");
