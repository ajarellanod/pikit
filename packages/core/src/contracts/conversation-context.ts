/**
 * The conversation a run belongs to, in the run's context (SPEC §6.3).
 *
 * The runtime puts the run's `ConversationRef` in the context of every run, next to its
 * `AGENT_STATE`, and Pi hands that context to each tool call. A tool that needs to know whose run it
 * works in (the tool components resolve the agent's `workspace` from it) reads it:
 *
 *   const conversation = context.value(CONVERSATION);
 *
 * `undefined` means the call is not part of a run (a test, or a tool called directly).
 *
 * A context value for the same reason as `AGENT_STATE`: a tool has no `ConversationRef` of its own,
 * and a project's tool objects are not components. It is read-only data about the run, scoped to it.
 */

import type { ConversationRef } from "../agent.ts";
import { type ContextKey, createContextKey } from "../context.ts";

/** Where a run's context carries the conversation it runs in. */
export const CONVERSATION: ContextKey<ConversationRef> = createContextKey<ConversationRef>("pikit.conversation");
