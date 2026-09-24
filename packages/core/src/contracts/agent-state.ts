/**
 * `agent.state` (SPEC §6.2a): the per-conversation JSON document an agent's `prepare(state)` reads
 * and its tools update. It lives in the conversation's Pi session, so it commits with the session,
 * survives restarts and eviction, and starts fresh after a reset (a new session). The runtime
 * provides it; pikit keeps no store of its own.
 *
 * A tool reaches the state of the conversation it runs in through its context, not through a
 * global or a capability: the runtime puts the conversation's `AgentState` in the context of every
 * run, and Pi hands that context to each tool call.
 *
 *   const state = context.value(AGENT_STATE);
 *   await state?.update({ phase: "deploying" }, context);
 *
 * A context value rather than a capability because a tool has no `ConversationRef` of its own, and
 * a project's tool objects are not components: they cannot `use()` anything. The value is scoped to
 * one run of one conversation, so a tool can never touch another conversation's state.
 */

import { type Context, type ContextKey, createContextKey } from "../context.ts";

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

/**
 * Whether `value` is a plain JSON object whose values are all JSON: what `agent.state` holds and what
 * a patch may contain. Internal to the core (the adapter checks its own writes).
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(value).every(isJson);
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
