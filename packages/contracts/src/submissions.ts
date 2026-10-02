/**
 * `agent.submissions`: what became of each admitted message, across processes, read from the runtime.
 *
 * The runtime records a message when it admits it and settles it when the run that took it ends; it
 * is the only writer, and this contract is how the others read it. Two readers need that record and
 * cannot get it from events, which die with their process (SPEC K3):
 * - **the runtime's host, at start** (`pending`): the conversations holding a message nobody answered
 *   yet, to resume them without waiting for a new message;
 * - **the channels** (`answers`): every run's outcome, as a feed read from a cursor of their own
 *   (K3), so an answer that ended while the channel was stopped, or whose delivery failed, is
 *   delivered when the channel reads again. `get` answers for one request (HTTP's `GET`).
 *
 * Shaped like pi-durable's own submissions: `pending` is its `queued` and `placed`; a `completed`
 * settlement is `done` with its answer; `failed`, `aborted` and `abandoned` are `unanswered` with a
 * reason. The runtime provides it (runtime-pi, from pi-durable, which keeps every submission and
 * deduplicates by request id): `pending` and `get` are the runtime's records, and `answers` is a log
 * derived from them, which pi-durable has no feed for. Giving up on messages nothing can answer is the
 * runtime's own operation (runtime-pi's `abandon`), not this contract's: a settlement is appended to
 * `answers` like any other, `failed` with `error.code` `abandoned`.
 *
 * The runtime's conversation stays the source of truth. A settlement carries the run's final text, not its
 * transcript (`messages`) or usage: what a channel needs to deliver it after a restart, kept in
 * `answers` only as long as the provider's retention.
 *
 * The in-memory double of `@pikit/contracts/testing` (`createMemorySubmissions`) adds the writes a
 * runtime double makes (`admitted`, `settled`, `abandoned`), for the tests of channels.
 */

import type { AppContext } from "@pikit/core";
import type { AgentResult, ConversationRef } from "./agent.ts";
import type { Feed } from "./feed.ts";

/**
 * How one run ended, as `answers` carries it: its `AgentResult` without the transcript and the usage.
 * The requests it took are settled with it; `answerKey(conversation, requestId)` names its answer.
 */
export type RunSettlement = Pick<AgentResult, "conversation" | "requestId" | "requestIds" | "kind" | "text" | "error">;

/** Where one request is: admitted and waiting for its run's end, or settled by a run. */
export type SubmissionStatus =
  | { kind: "pending"; conversation: ConversationRef; requestId: string }
  | { kind: "settled"; conversation: ConversationRef; requestId: string; run: RunSettlement };

/** One conversation with requests admitted and not settled, oldest first. */
export interface PendingConversation {
  conversation: ConversationRef;
  requestIds: string[];
  /**
   * When the oldest of `requestIds` was admitted, in epoch milliseconds of the provider's clock: how
   * long the conversation has waited, for the runtime to give up on requests nothing can answer.
   */
  oldestAdmittedAt: number;
}

export interface AgentSubmissions {
  /**
   * Every conversation with a request admitted and not settled, ordered by its oldest pending request
   * (a request already settled does not count).
   */
  pending(ctx: AppContext): Promise<PendingConversation[]>;
  /**
   * Where `requestId` is in the runtime's conversation, or `undefined` if it is unknown there (never
   * admitted, or settled longer ago than the provider keeps settlements; a runtime that provides this
   * contract keeps them as long as the conversation). Requests are per conversation, as pi-durable
   * deduplicates them.
   */
  get(conversation: Pick<ConversationRef, "conversationId">, requestId: string, ctx: AppContext): Promise<SubmissionStatus | undefined>;
  /**
   * Every settlement, in the order it was committed (SPEC K3). A channel delivers from it with a
   * cursor of its own; `agent.settled` and `agent.failed` only wake it.
   */
  readonly answers: Feed<RunSettlement>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "agent.submissions": AgentSubmissions;
  }
}
