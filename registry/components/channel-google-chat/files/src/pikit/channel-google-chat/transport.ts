// Owner: transport. The ChannelTransport of one instance (features/channel-google-chat.md "Answers", "Questions").
/**
 * - `idempotent: true`, `draws: ["question"]` (fixed: index.ts and answer delivery read them at start).
 * - `split`: `splitAnswer` (format.ts).
 * - `send(piece)`: where it goes is `targets.of(piece.conversationKey, answerKey)` (ids.ts `pieceOf`);
 *   `undefined` is `permanent`. Its ids (ids.ts `pieceIds(piece.key)`); its message `chatMessageOf
 *   (piece.text)` plus, on the last piece, each `question` part drawn by `drawQuestion(part,
 *   credentials.audience)` as a card.
 *   - **Piece `#0`** edits the placeholder (`api.updateMessage(messageNameOf(space, messageId), …,
 *     ["text", "cardsV2"])`: a repeat is harmless); when there is none (`NOT_FOUND`: the channel was
 *     down when the run started) it creates the message under the same ids. Its placeholder mark is
 *     removed once it is the answer (`marks.remove(answerKey)`).
 *   - **Other pieces** are created (`api.createMessage(space, …, { thread, requestId, messageId })`).
 *   - **A late repeat** (`ALREADY_EXISTS` on create: Google forgot the `requestId`, the `messageId`
 *     exists) is read (`api.getMessage`) and counted delivered.
 *   - A drawn question's message is recorded (`questions.sent`) under the question's id.
 *   - Failures: `deliveryErrorOf` (api.ts). Resolves with `{ platformMessageId: message.name }`.
 */

import type { ChannelTransport } from "@pikit/contracts";
import type { Credentials, Instance } from "./instance.ts";
import type { AnswerTargets, ChatApi, PlaceholderMarks, QuestionDrawer, QuestionRecords } from "./types.ts";

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
  void deps;
  return {
    idempotent: true,
    draws: DRAWS,
    split: () => {
      throw new Error("not implemented: transport (transport.ts split)");
    },
    send: async () => {
      throw new Error("not implemented: transport (transport.ts send)");
    },
  };
}
