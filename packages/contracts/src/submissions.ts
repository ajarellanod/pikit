/**
 * `agent.submissions`: what became of each admitted message, across processes.
 *
 * The runtime records a message when it admits it and settles it when the run that took it ends. Two
 * readers need that record and cannot get it from events, which die with their process (SPEC K3):
 * - **the runtime, at start** (`pending`): the conversations holding a message nobody answered yet,
 *   to resume them without waiting for a new message;
 * - **the channels** (`answers`): every run's outcome, as a feed read from a cursor of their own
 *   (K3), so an answer that ended while the channel was stopped, or whose delivery failed, is
 *   delivered when the channel reads again. `get` answers for one request (HTTP's `GET`).
 *
 * Shaped like pi-durable's own submissions: `pending` is its `queued` and `placed`; a `completed`
 * settlement is `done` with its answer; `failed`, `aborted` and `abandoned` are `unanswered` with a
 * reason. The runtime runs on pi-durable, which keeps them itself (`Conversation.submit()` deduplicates
 * by request id); this contract bridges them for what one pi-durable storage cannot answer: which
 * conversations hold pending work across storages (`pending`, an index; a Durable Object per chat has
 * a storage each), and the feed channels deliver from.
 *
 * The runtime's conversation stays the source of truth. A settlement carries the run's final text, not its
 * transcript (`messages`) or usage: what a channel needs to deliver it after a restart, kept only as
 * long as the provider's retention.
 *
 * **Transitional**, not only `experimental`: the capability catalogue marks it so, and `pikit registry
 * capabilities` says it, so that a component outside this repository knows before depending on it.
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
   * The runtime admitted `requestId` in `conversation`: it is pending until a run settles it. Called
   * after the message is durable in the runtime's conversation and before `dispatch` resolves, so a channel
   * acknowledges its platform only once both hold it. A request already known, pending or settled,
   * is left as it is.
   */
  admitted(conversation: ConversationRef, requestId: string, ctx: AppContext): Promise<void>;
  /**
   * A run ended: every request in `run.requestIds` is settled by it, and `run` is appended to
   * `answers`, in one commit. A request never admitted is recorded settled all the same (its
   * admission was lost with a crash). Idempotent within the provider's retention: a run already
   * settled (the same conversation and `requestId`) changes nothing, and a request keeps the first run
   * that settled it. Once a settlement is pruned, the provider no longer knows it: settling the same
   * run again appends it to `answers` a second time.
   */
  settled(run: RunSettlement, ctx: AppContext): Promise<void>;
  /**
   * The runtime gives up on requests nothing can answer (their agent was removed, their conversation is
   * gone, or they waited too long with no run to take them): those of `requestIds` still pending are
   * settled unanswered, and one settlement is appended to `answers` for them, in one commit: `failed`,
   * `error: { code: "abandoned", message: reason }`, `requestId` the first of them and `requestIds`
   * them all. Never pretends they were answered; tells their channel so, which tells the user.
   * A request already settled, or unknown, is left as it is. Resolves with the settlement appended,
   * or `undefined` when none of them was pending (so abandoning again changes nothing), for the
   * caller to announce it as `agent.failed`.
   */
  abandoned(conversation: ConversationRef, requestIds: readonly string[], reason: string, ctx: AppContext): Promise<RunSettlement | undefined>;
  /**
   * Every conversation with a request admitted and not settled, ordered by its oldest pending request
   * (a request already settled does not count).
   */
  pending(ctx: AppContext): Promise<PendingConversation[]>;
  /**
   * Where `requestId` is in the runtime's conversation, or `undefined` if it is unknown there (never
   * admitted, or settled longer ago than the provider keeps settlements). Requests are per conversation,
   * as pi-durable deduplicates them.
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
