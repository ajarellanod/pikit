// Owner: transport. The ChannelTransport of one instance (features/channel-google-chat.md "Answers", "Questions").
/**
 * - `idempotent: true`, `draws: ["question"]` (fixed: index.ts and answer delivery read them at start).
 * - `split`: `splitAnswer` (format.ts).
 * - `send(piece)`: where it goes is `targets.of(piece.conversationKey, answerKey)` (ids.ts `pieceOf`);
 *   `undefined` is `permanent`. **A dashboard-led run** (its answer's request is the dashboard's, which
 *   recorded no thread: a user's message was queued behind it) goes to the thread of the first of its
 *   requests that is not the dashboard's (`requestsOf`). Its ids (ids.ts `pieceIds(piece.key)`); its
 *   message `chatMessageOf(piece.text)` plus, on the last piece, each `question` part drawn by
 *   `drawQuestion(part, credentials.audience, piece.conversationKey, answered)` as a card: a question
 *   whose claim exists (`questions.get`) is drawn answered, so a piece sent again never brings its
 *   buttons back.
 *   - **Google's 32,000 bytes** (`MESSAGE_BYTES`) are measured on the complete message, its drawn cards
 *     too (`messageBytes`). A message that would pass them is sent as two: the text (and its own cards)
 *     as the piece's message, then the drawn cards as a message of their own right after it, created
 *     under ids from `${piece.key}:parts` (the same on every retry). The questions' records point at
 *     the message their cards are in. Drawn cards that pass the bytes alone are `permanent`, logged by
 *     delivery as an error: never a question lost silently.
 *   - **Piece `#0`** edits the placeholder (`api.updateMessage(messageNameOf(space, messageId), …,
 *     ["text", "cardsV2"])`: a repeat is harmless); when there is none (`NOT_FOUND`: the channel was
 *     down when the run started) it creates the message under the same ids. Google may hand back the
 *     placeholder itself (the same `requestId`): when its text or cards are not the piece's, it is
 *     edited. Its placeholder mark is removed once it is the answer (`marks.remove(answerKey)`).
 *   - **Other pieces** are created (`api.createMessage(space, …, { thread, requestId, messageId })`).
 *   - **A late repeat** (`ALREADY_EXISTS` on create: Google forgot the `requestId`, the `messageId`
 *     exists) is read (`api.getMessage`) and counted delivered.
 *   - Before piece `#0`, the answer's preview gate is closed (placeholder.ts `previewGateOf`): no
 *     preview is written over the answer, and a placeholder's call in flight ends first. A preview
 *     whose call timed out may still land later, over the answer: then piece `#0` is applied again
 *     after `reapplyAfterMs` (a value).
 *   - A piece of empty text carries drawn parts only: its message is their cards.
 *   - A drawn question's message is recorded (`questions.sent`) under the question's id, with the
 *     key of the answer that drew it (it names the conversation asked in: a reset closes it).
 *   - Failures: `deliveryErrorOf` (api.ts): 429 `rate_limited`, network and 5xx `transient`
 *     (`maybeSent` after a timeout), 400/401/403/404 `permanent`, the token endpoint's refusals
 *     `transient` (a key to fix); a piece whose message is too large (`chatMessageOf`) `permanent`.
 *     Resolves with `{ platformMessageId: message.name }` (the text's message).
 */

import { answerKey as answerKeyOf, type ChannelTransport, DASHBOARD_REQUEST_PREFIX, DeliveryError, isDashboardRequest, type QuestionPart } from "@pikit/contracts";
import { deliveryErrorOf } from "./api.ts";
import type { CardWithId, ChatMessage } from "./event.ts";
import { chatMessageOf, MESSAGE_BYTES, messageBytes, splitAnswer } from "./format.ts";
import { messageNameOf, type PieceIds, pieceIds, pieceOf } from "./ids.ts";
import type { Credentials, Instance } from "./instance.ts";
import { previewGateOf } from "./placeholder.ts";
import { type AnswerTarget, type AnswerTargets, type ChatApi, ChatApiError, type PlaceholderMarks, type QuestionDrawer, type QuestionRecords } from "./types.ts";

export interface TransportDeps {
  instance: Instance;
  credentials: Credentials;
  api: ChatApi;
  targets: AnswerTargets;
  marks: PlaceholderMarks;
  questions: QuestionRecords;
  drawQuestion: QuestionDrawer;
  /** The requests the run that settled `requestId` of the conversation `conversationId` took (`RunSettlement.requestIds`), or `undefined` when unknown. */
  requestsOf(conversationId: string, requestId: string): Promise<readonly string[] | undefined>;
  /** How long, in ms, after piece `#0` it is applied again when a preview's call timed out: `REAPPLY_AFTER_MS` by default. A value, for tests. */
  reapplyAfterMs?: number;
}

/** The part kinds this transport draws. */
export const DRAWS: readonly string[] = ["question"];

/** How long, in ms, piece `#0` waits to be applied again over a preview whose call timed out (it may land late). */
export const REAPPLY_AFTER_MS = 3_000;

/** Whether Google's message already says what `message` says: its text and its cards. */
const sameContent = (sent: ChatMessage, message: ChatMessage): boolean =>
  (sent.text ?? "") === (message.text ?? "") && JSON.stringify(sent.cardsV2 ?? []) === JSON.stringify(message.cardsV2 ?? []);

/** Waits `ms`; rejects with `signal`'s reason once it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The transport of one instance. Its fields are read at start; its methods only when an answer is sent. */
export function createTransport(deps: TransportDeps): ChannelTransport {
  const { api } = deps;
  const gate = previewGateOf(deps.marks);
  const reapplyAfterMs = deps.reapplyAfterMs ?? REAPPLY_AFTER_MS;

  /** Where `answerKey`'s answer goes; a dashboard-led run's in the thread of its first request that is not the dashboard's. */
  const targetOf = async (conversationKey: string, answerKey: string): Promise<AnswerTarget | undefined> => {
    const target = await deps.targets.of(conversationKey, answerKey);
    if (target === undefined || target.thread !== undefined) return target;
    const at = answerKey.indexOf(`:${DASHBOARD_REQUEST_PREFIX}`);
    if (at < 0) return target;
    const conversationId = answerKey.slice(0, at);
    const requests = await deps.requestsOf(conversationId, answerKey.slice(at + 1));
    const first = requests?.find((each) => !isDashboardRequest(each));
    return first === undefined ? target : deps.targets.of(conversationKey, answerKeyOf({ conversationId }, first));
  };

  return {
    idempotent: true,
    draws: DRAWS,
    split: (text) => splitAnswer(text),
    async send(piece, signal) {
      try {
        const { answerKey, index } = pieceOf(piece.key);
        const target = await targetOf(piece.conversationKey, answerKey);
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
        const drawn: CardWithId[] = [];
        for (const question of questions) drawn.push(deps.drawQuestion(question, deps.credentials.audience, piece.conversationKey, (await deps.questions.get(question.id))?.answered));

        // The complete message measured: past Google's bytes, the drawn cards go in a message of their own.
        const whole: ChatMessage = { text: content.text, cardsV2: [...content.cardsV2, ...drawn] };
        const hasOwn = content.text !== "" || content.cardsV2.length > 0;
        const apart = drawn.length > 0 && hasOwn && messageBytes(whole) > MESSAGE_BYTES;
        const message: ChatMessage = apart ? content : whole;
        const parts: ChatMessage | undefined = apart ? { text: "", cardsV2: drawn } : undefined;
        const tooLarge = (what: ChatMessage) => messageBytes(what) > MESSAGE_BYTES;
        if (parts !== undefined ? tooLarge(parts) : drawn.length > 0 && !hasOwn && tooLarge(message)) {
          throw new DeliveryError("permanent", `the cards of the questions ${questions.map((each) => each.id).join(", ")} are more than Google takes in a message (${MESSAGE_BYTES} bytes); they are not sent`);
        }

        /** Created under `as`; a late repeat (Google forgot the `requestId`, the `messageId` exists) read back. */
        const create = async (what: ChatMessage, as: PieceIds): Promise<ChatMessage> => {
          try {
            return await api.createMessage(target.space, what, { ...(target.thread !== undefined && { thread: target.thread }), requestId: as.requestId, messageId: as.messageId }, signal);
          } catch (error) {
            if (!(error instanceof ChatApiError && (error.status === 409 || error.code === "ALREADY_EXISTS"))) throw error;
            return api.getMessage(messageNameOf(target.space, as.messageId), signal);
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
            sent = await create(message, ids);
            // What Google gave back may be the placeholder itself (the same `requestId`): edited.
            if (!sameContent(sent, message)) sent = await edit();
          }
          // A preview whose call timed out may land after the edit: applied again once it would have.
          if (gate.uncertain(answerKey)) {
            await pause(reapplyAfterMs, signal);
            sent = await edit();
          }
        } else {
          sent = await create(message, ids);
        }
        const platformMessageId = sent.name ?? name;
        let cardsAt = platformMessageId;
        if (parts !== undefined) {
          const partIds = await pieceIds(`${piece.key}:parts`);
          cardsAt = (await create(parts, partIds)).name ?? messageNameOf(target.space, partIds.messageId);
        }
        for (const question of questions) await deps.questions.sent({ question, message: cardsAt, conversationKey: piece.conversationKey, answerKey });
        // The placeholder is the answer now; a mark left (this failed) is dropped by the next sweep.
        if (index === 0) await deps.marks.remove(answerKey).catch(() => {});
        return { platformMessageId };
      } catch (error) {
        throw deliveryErrorOf(error);
      }
    },
  };
}
