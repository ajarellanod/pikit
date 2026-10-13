/**
 * The requests a run takes, and who sent each one, in the run's context.
 *
 * A run answers one or more messages (`AgentResult.requestIds`: the one that started it, the follow-ups
 * queued with it, the steers that joined it). The runtime keeps each message's `AgentRequest.sender`
 * with it, durably, and puts `RUN_REQUESTS` in the context of everything that runs for the run: its
 * tools, and the hooks and system prompt sections of the agent's extensions. Code that must know who
 * it acts for (whose memory, which rules) reads it there, never from the model:
 *
 *   const requests = await context.value(RUN_REQUESTS)?.list(context);
 *   const senders = requests?.flatMap((request) => (request.sender === undefined ? [] : [request.sender]));
 *
 * `undefined` means the code runs outside a run (a test, a tool called directly). The list is read when
 * asked, so it is the run's as it is then: a steer that joined the run is in it from its tool round on.
 * Which senders a policy requires (every one of them, the last one) is the policy's: a run may answer
 * several people at once in a group chat.
 *
 * A context value for the same reason as `AGENT_STATE`: a tool has no request of its own, and the
 * values a caller puts in its own context never reach a run (pi-durable runs it in its own context:
 * docs/upstream, proposal 3, which this replaces until Pi carries attributes on submissions).
 */

import { type Context, type ContextKey, createContextKey } from "@pikit/core";
import type { Sender } from "./agent.ts";

/** One message a run takes. */
export interface RunRequest {
  /** Its `AgentRequest.requestId`. */
  requestId: string;
  /** Its `AgentRequest.sender`, when it had one. */
  sender?: Sender;
}

export interface RunRequests {
  /**
   * The messages the run in progress takes, in the order it took them: the one that started it first.
   * Empty when the conversation has no run going (a compaction while idle). A copy.
   */
  list(ctx: Context): Promise<readonly RunRequest[]>;
}

/** Where a run's context carries the requests it takes. */
export const RUN_REQUESTS: ContextKey<RunRequests> = createContextKey<RunRequests>("pikit.run.requests");
