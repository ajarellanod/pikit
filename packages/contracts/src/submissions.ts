/**
 * `agent.submissions` (SPEC §6.1, §6.4): what became of each admitted message, across processes.
 *
 * The runtime records a message when it admits it and settles it when the run that took it ends. Two
 * readers need that record and cannot get it from events, which die with their process (§4.3):
 * - **the runtime, at start** (`pending`): the conversations holding a message nobody answered yet,
 *   to resume them without waiting for a new message;
 * - **the channels** (`answers`): every run's outcome, as a feed read from a cursor of their own
 *   (§4.8), so an answer that ended while the channel was stopped, or whose delivery failed, is
 *   delivered when the channel reads again. `get` answers for one request (HTTP's `GET`).
 *
 * Shaped like the submissions of Pi's durable runtime (`packages/durable/docs/pico-v5.md` §6):
 * `pending` is its `queued` and `placed`; a `completed` settlement is `done` with its answer; `failed`
 * and `aborted` are `unanswered` with a reason. Pi's submissions are not implemented yet (package 18 of
 * `pico-v5-handoff.md`, checked at `c1449660`). When the adapter moves to them, `admitted` and
 * `settled` become Pi's own records and this contract is bridged or deleted; what stays is what one
 * Pi session cannot know: which sessions hold pending work (`pending`, an index across sessions), and
 * the feed channels deliver from.
 *
 * The session stays the source of truth. A settlement carries the run's final text, not its
 * transcript (`messages`) or usage: what a channel needs to deliver it after a restart, kept only as
 * long as the provider's retention.
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
}

export interface AgentSubmissions {
  /**
   * The runtime admitted `requestId` in `conversation`: it is pending until a run settles it. Called
   * after the message is durable in the session and before `dispatch` resolves, so a channel
   * acknowledges its platform only once both hold it. A request already known, pending or settled,
   * is left as it is.
   */
  admitted(conversation: ConversationRef, requestId: string, ctx: AppContext): Promise<void>;
  /**
   * A run ended: every request in `run.requestIds` is settled by it, and `run` is appended to
   * `answers`, in one commit. A request never admitted is recorded settled all the same (its
   * admission was lost with a crash). Idempotent: a run already settled (the same session and
   * `requestId`) changes nothing, and a request keeps the first run that settled it.
   */
  settled(run: RunSettlement, ctx: AppContext): Promise<void>;
  /** Every conversation with a request admitted and not settled, the oldest first. */
  pending(ctx: AppContext): Promise<PendingConversation[]>;
  /**
   * Where `requestId` is in the conversation's session, or `undefined` if it is unknown there (never
   * admitted, or settled longer ago than the provider keeps settlements). Requests are per session,
   * as Pi deduplicates them.
   */
  get(conversation: Pick<ConversationRef, "sessionId">, requestId: string, ctx: AppContext): Promise<SubmissionStatus | undefined>;
  /**
   * Every settlement, in the order it was committed (SPEC §4.8). A channel delivers from it with a
   * cursor of its own; `agent.settled` and `agent.failed` only wake it.
   */
  readonly answers: Feed<RunSettlement>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "agent.submissions": AgentSubmissions;
  }
}
