/**
 * How answers reach the users: the channels' path, `startAnswerDelivery` (`@pikit/contracts`), whose
 * platform is the channel's own table (`store.ts`). The transport writes each answer there under its
 * idempotency key (written twice, stored once: it is idempotent), moves the conversation's activity,
 * and tells who follows it live.
 *
 * - **Which runs**: those of a `web:` key (`route`). A run only `dashboard:` requests started (an
 *   operator's follow-up) is passed over by the helper itself: the user never sees it.
 * - **What is written** (`answerText`): a completed run's answer. A run that failed or was aborted
 *   writes nothing: its messages' states say so (`failed`, `aborted`), and the page offers to send
 *   again.
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

/** The instance of a conversation key: this channel's, or `undefined`. */
export const routeOf = (key: string): string | undefined => (parseKey(key) === undefined ? undefined : INSTANCE);

/** What a run writes in the conversation: a completed run's answer, or nothing. */
export function answerText(answer: Pick<RunSettlement, "kind" | "text">): string | undefined {
  return answer.kind === "completed" && (answer.text ?? "").trim() !== "" ? answer.text : undefined;
}

export interface TransportOptions {
  store: ChatStore;
  now(): number;
  /** The conversation's row changed (its activity): tell the index. */
  changed(row: ConversationRow): Promise<void>;
}

/** The transport into the channel's table. */
export function createTransport({ store, now, changed }: TransportOptions): ChannelTransport {
  return {
    idempotent: true,
    // One answer, one message: the table takes any length.
    split: (text) => [text],
    async send(piece) {
      const at = now();
      if (await store.add(piece.conversationKey, { id: piece.key, role: "assistant", text: piece.text, at })) {
        const row = await store.change(piece.conversationKey, { activity: at });
        if (row !== undefined) await changed(row);
      }
      store.notify(piece.conversationKey, { type: "message", id: piece.key, answer: true });
      return { platformMessageId: piece.key };
    },
  };
}
