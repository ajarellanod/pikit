// Owner: transport. The ChannelTransport of one instance (features/channel-google-chat.md "Answers", "Questions").
/**
 * - `idempotent: true`, `draws: ["question"]` (fixed: index.ts and answer delivery read them at start).
 * - `split`: `splitAnswer` (format.ts).
 * - `send(piece)`: where it goes is `targets.of(piece.conversationKey, answerKey)` (ids.ts `pieceOf`);
 *   `undefined` is `permanent`. Its ids (ids.ts `pieceIds(piece.key)`); its message `chatMessageOf
 *   (piece.text)` plus, on the last piece, each `question` part drawn by `drawQuestion(part,
 *   credentials.audience, piece.conversationKey)` as a card.
 *   - **Piece `#0`** edits the placeholder (`api.updateMessage(messageNameOf(space, messageId), …,
 *     ["text", "cardsV2"])`: a repeat is harmless); when there is none (`NOT_FOUND`: the channel was
 *     down when the run started) it creates the message under the same ids. Its placeholder mark is
 *     removed once it is the answer (`marks.remove(answerKey)`).
 *   - **Other pieces** are created (`api.createMessage(space, …, { thread, requestId, messageId })`).
 *   - **A late repeat** (`ALREADY_EXISTS` on create: Google forgot the `requestId`, the `messageId`
 *     exists) is read (`api.getMessage`) and counted delivered.
 *     Google may hand back the placeholder itself (the same `requestId`): its text not the piece's,
 *     it is edited.
 *   - Before piece `#0`, the answer's preview gate is closed (placeholder.ts `previewGateOf`): no
 *     preview is written over the answer, and a placeholder's creation in flight ends first.
 *   - A piece of empty text carries drawn parts only: its message is their cards.
 *   - A drawn question's message is recorded (`questions.sent`) under the question's id, with the
 *     key of the answer that drew it (it names the conversation asked in: a reset closes it).
 *   - Failures: `deliveryErrorOf` (api.ts): 429 `rate_limited`, network and 5xx `transient`
 *     (`maybeSent` after a timeout), 400/401/403/404 `permanent`; a piece whose message is too large
 *     (`chatMessageOf`) `permanent`. Resolves with `{ platformMessageId: message.name }`.
 */

import { type ChannelTransport, DeliveryError, type QuestionPart } from "@pikit/contracts";
import { deliveryErrorOf } from "./api.ts";
import type { CardWithId, ChatMessage } from "./event.ts";
import { chatMessageOf, splitAnswer } from "./format.ts";
import { messageNameOf, pieceIds, pieceOf } from "./ids.ts";
import type { Credentials, Instance } from "./instance.ts";
import { previewGateOf } from "./placeholder.ts";
import { type AnswerTargets, type ChatApi, ChatApiError, type PlaceholderMarks, type QuestionDrawer, type QuestionRecords } from "./types.ts";

export interface TransportDeps {
  instance: Instance;
  credentials: Credentials;
  api: ChatApi;
  targets: AnswerTargets;
  marks: PlaceholderMarks;
  questions: QuestionRecords;
  drawQuestion: QuestionDrawer;
}

/** The part kinds this transport draws. */
export const DRAWS: readonly string[] = ["question"];

/** The transport of one instance. Its fields are read at start; its methods only when an answer is sent. */
export function createTransport(deps: TransportDeps): ChannelTransport {
  const { api } = deps;
  const gate = previewGateOf(deps.marks);
  return {
    idempotent: true,
    draws: DRAWS,
    split: (text) => splitAnswer(text),
    async send(piece, signal) {
      try {
        const { answerKey, index } = pieceOf(piece.key);
        const target = await deps.targets.of(piece.conversationKey, answerKey);
        if (target === undefined) throw new DeliveryError("permanent", `"${piece.conversationKey}" is not a conversation of the Chat app ${deps.instance.instance}`);
        const ids = await pieceIds(piece.key);
        const name = messageNameOf(target.space, ids.messageId);
        let content: { text: string; cardsV2: CardWithId[] };
        try {
          content = chatMessageOf(piece.text);
        } catch (error) {
          throw new DeliveryError("permanent", error instanceof Error ? error.message : String(error));
        }
        const questions = (piece.parts ?? []).filter((part): part is QuestionPart => part.type === "question");
        const message: ChatMessage = { text: content.text, cardsV2: [...content.cardsV2, ...questions.map((question) => deps.drawQuestion(question, deps.credentials.audience, piece.conversationKey))] };

        /** Created under the piece's ids; a late repeat (Google forgot the `requestId`, the `messageId` exists) read back. */
        const create = async (): Promise<ChatMessage> => {
          try {
            return await api.createMessage(target.space, message, { ...(target.thread !== undefined && { thread: target.thread }), requestId: ids.requestId, messageId: ids.messageId }, signal);
          } catch (error) {
            if (!(error instanceof ChatApiError && (error.status === 409 || error.code === "ALREADY_EXISTS"))) throw error;
            return api.getMessage(name, signal);
          }
        };
        const edit = (): Promise<ChatMessage> => api.updateMessage(name, message, ["text", "cardsV2"], signal);

        let sent: ChatMessage;
        if (index === 0) {
          // No preview after this, nor one in flight: the answer is the last word.
          await gate.close(answerKey);
          try {
            sent = await edit();
          } catch (error) {
            if (!(error instanceof ChatApiError && error.status === 404)) throw error;
            // No placeholder (the channel was down when the run started): the message is the answer.
            sent = await create();
            // What Google gave back may be the placeholder itself (the same `requestId`): edited.
            if ((sent.text ?? "") !== message.text) sent = await edit();
          }
        } else {
          sent = await create();
        }
        const platformMessageId = sent.name ?? name;
        for (const question of questions) await deps.questions.sent({ question, message: platformMessageId, conversationKey: piece.conversationKey, answerKey });
        // The placeholder is the answer now; a mark left (this failed) is dropped by the next sweep.
        if (index === 0) await deps.marks.remove(answerKey).catch(() => {});
        return { platformMessageId };
      } catch (error) {
        throw deliveryErrorOf(error);
      }
    },
  };
}
