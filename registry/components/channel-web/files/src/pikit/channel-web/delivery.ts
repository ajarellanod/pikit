/**
 * How answers reach the users when a run's end was not heard: the channels' path, `startAnswerDelivery`
 * (`@pikit/contracts`), whose platform is the channel's own table (`store.ts`).
 *
 * What users read of a run is what it wrote, stored whole when it ends (`agent.settled`,
 * `agent.failed`: `index.ts`). Delivery is the durable path beside it, from the record of every run's
 * end: its transport writes a completed run's answer as one assistant message (an `answer` entry), only
 * for a run none of whose messages are stored (an end this App never heard: a crash, a handler that
 * failed). A run's messages stored later replace it. So an answer is never lost, and never shown twice.
 *
 * - **Which runs**: those of a `web:` key (`route`). A run only `dashboard:` requests started (an
 *   operator's follow-up) is passed over by the helper itself: the user never sees it.
 * - **What is written** (`answerText`): a completed run's answer. A run that failed or was aborted
 *   writes nothing here: its messages' states say so (`failed`, `aborted`), and what it wrote is stored
 *   with it when its end is heard.
 * - **Before writing**, the transport waits for the end of the run to be heard (`settled`, at most
 *   `HEARD_WAIT_MS`): its messages are then stored, and it writes nothing.
 * - **Policy**: a failed write is tried again after 1 s, 5 s, 30 s, then every minute, logged as an
 *   error from its 3rd failure in a row; a run writes at most 50 answers; a write not done in 10 s
 *   may have happened (it is idempotent: written again, stored once).
 */

import type { ChannelTransport, DeliveryPolicy, RunSettlement } from "@pikit/contracts";
import { parseKey } from "./chat.ts";
import type { ChatStore, ConversationRow } from "./store.ts";

/** The one instance of the channel, as `startAnswerDelivery` names it. */
export const INSTANCE = "web";

export const DELIVERY: DeliveryPolicy = { retryMs: [1_000, 5_000, 30_000, 60_000], blockedAfter: 3, window: 200, piecesPerRun: 50, sendTimeoutMs: 10_000 };

/** How long the transport waits for a run's end to be heard before it writes the answer itself. */
export const HEARD_WAIT_MS = 1_000;

/** The instance of a conversation key: this channel's, or `undefined`. */
export const routeOf = (key: string): string | undefined => (parseKey(key) === undefined ? undefined : INSTANCE);

/** What a run writes in the conversation: a completed run's answer, or nothing. */
export function answerText(answer: Pick<RunSettlement, "kind" | "text">): string | undefined {
  return answer.kind === "completed" && (answer.text ?? "").trim() !== "" ? answer.text : undefined;
}

/** The run a piece's key names (`answerKey(conversation, requestId)#<index>`): the request that started it. */
export function runOfPiece(pieceKey: string): string | undefined {
  return /^.*?:((?:web|dashboard):.+)#[0-9]+$/s.exec(pieceKey)?.[1];
}

export interface TransportOptions {
  store: ChatStore;
  now(): number;
  /** The conversation's row changed (its activity): tell the index. */
  changed(row: ConversationRow): Promise<void>;
  /** Resolves once the end of the run `run` of `key` was heard and handled here, or after `HEARD_WAIT_MS` when it was not. */
  heard(key: string, run: string): Promise<void>;
}

/** The transport into the channel's table. */
export function createTransport({ store, now, changed, heard }: TransportOptions): ChannelTransport {
  return {
    idempotent: true,
    // One answer, one message: the table takes any length.
    split: (text) => [text],
    async send(piece) {
      const run = runOfPiece(piece.key) ?? piece.key;
      await heard(piece.conversationKey, run);
      const at = now();
      const message = { role: "assistant", content: [{ type: "text", text: piece.text }], timestamp: at, stopReason: "stop" };
      if (piece.text.trim() !== "" && (await store.addAnswer(piece.conversationKey, run, piece.key, message, at))) {
        const row = await store.change(piece.conversationKey, { activity: at });
        if (row !== undefined) await changed(row);
        store.notify(piece.conversationKey, { type: "changed" });
      }
      return { platformMessageId: piece.key };
    },
  };
}
