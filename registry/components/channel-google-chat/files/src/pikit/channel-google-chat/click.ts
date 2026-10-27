// Owner: questions. A question's click or form, answered and admitted (features/channel-google-chat.md "Questions").
/**
 * The same code on both targets: on a server the route calls it in process, on Cloudflare the
 * conversation's object answers `google-chat.click` (`actor.inbox.answer`).
 *
 * - **The click's key** is its action's `key` parameter (every action carries it), checked by the
 *   route (this instance, the click's space): never the `conversations` setting of now, so a card
 *   drawn in a thread stays its thread's when the setting turns the chat into one conversation.
 * - The click's parameters (question-cards.ts `CLICK_PARAMETERS`) name the question; its record
 *   (`QuestionRecords.get`) says its card's message and conversation. Unknown, or a record whose
 *   `conversationKey` is not the click's key (a forged `key`: all records share one `storage.kv`):
 *   the click is answered with a notice, nothing admitted, no card touched. A click from a space not
 *   allowed, or from no user, is refused the same way (the route tells strangers: this is a guard).
 * - `CANCEL_DIALOG`: the dialog closed, nothing else.
 * - `open`: the dialog (`questionDialog`), as `action.navigations[0].pushCard`.
 * - `answer` / `submit`: the answer read from the parameters or `formInputs` (`stringInputs`,
 *   `dateInput` as `YYYY-MM-DD`), checked (`answerProblem` from `@pikit/contracts`): a problem is a
 *   notice for a button, and for a form the dialog drawn again with the problem and the answers kept
 *   (`updateCard`).
 * - **Admitted once.** The answer is admitted (`admitInbound`) as a message whose text is
 *   `answerText(question, answer)`, from the clicker (`actor.id` their `users/…`), id
 *   `<card message name>:<question id>:answer` (`answerMessageId`): one id per question (a message may
 *   carry several questions), so the runtime takes one answer however many people click at once or
 *   Google repeats a click (the others are `duplicate`), and the record is marked answered
 *   (`QuestionRecords.answer`, a claim) once the message is durable. Admitted first, marked after: a
 *   click that fails in between (a capability, a stop) leaves the claim missing, and the next click
 *   finds the message there (`duplicate`), claims it and updates the card, so the question closes.
 *   `denied`, `halted` and `no_route` admit nothing and leave it open, with a notice.
 * - Its space (`AdmitOptions.space`) is the chat's own key (`<instance>:<space>`), as handler.ts gives
 *   every message of the chat.
 * - The answer's thread is recorded for a whole chat's conversation (`targets.remember`, awaited in
 *   `beforeDispatch` as handler.ts records a message's: a failure admits nothing and the click
 *   rejects), the card's thread: its answer goes under the question.
 * - **The card** is updated to `answeredCard` (who answered what), replacing only the question's card
 *   in its message: the click's response (`updateMessageAction`, with the message's text and its
 *   other cards) for a button whose click carries the message; otherwise (a form: a dialog's submit
 *   carries no message) the message is read (`api.getMessage`) and patched (`api.updateMessage`,
 *   `cardsV2`), never without its other cards (a read or a patch that fails is logged: the answer is
 *   in). A question already answered answers the click with that, and admits nothing.
 * - Anyone the channel admits in the conversation may answer; a question stays open until answered
 *   or its conversation is reset: a click once the key has no conversation, or one that is not the
 *   one the question was asked in (`QuestionRecord.answerKey` names it), is told so, and admits nothing.
 * - Resolves with the response and what became of the answer (`admitted`, `duplicate`, or `done`):
 *   index.ts wakes answer delivery after an `admitted` or `duplicate`, as after a message.
 *
 * Rejects only when a capability failed (the route answers 500).
 */

import type { AppContext } from "@pikit/core";
import {
  admitInbound,
  answerKey,
  answerProblem,
  answerText,
  type ConversationRef,
  type JsonValue,
  type KeyValueStore,
  type QuestionAnswer,
  type QuestionField,
  type QuestionValue,
} from "@pikit/contracts";
import { type AddOnEvent, type AddOnResponse, type CardWithId, type ChatMessage, type FormInput, spaceOf } from "./event.ts";
import { conversationKey, parseConversationKey } from "./instance.ts";
import { answeredCard, CLICK_PARAMETERS, type ClickStep, questionDialog } from "./question-cards.ts";
import type { AdmissionDeps, ClickHandler, ClickOutcome, HandledEvent, QuestionAnswered, QuestionRecord, QuestionRecords } from "./types.ts";

export interface ClickDeps extends AdmissionDeps {
  questions: QuestionRecords;
}

/** The notices a click is answered with. */
export const CLICK_NOTICES = {
  unknown: "This question is not known here any more, so it cannot be answered. Reply with your answer in a message.",
  answered: "This question was already answered.",
  reset: "This question was asked in a conversation that was reset, so it cannot be answered. Ask again in a message.",
  stranger: "This app does not answer in this space.",
  refused: "Your answer could not be taken.",
} as const;

/** A notice; for a dialog, the dialog closes with it. */
const notice = (text: string, dialog: boolean): AddOnResponse =>
  dialog ? { action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }], notification: { text } } } : { action: { notification: { text } } };

const CLOSE: AddOnResponse = { action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }] } };

/** The id of the message that answers `question`, whose card is in `cardMessage`: one per question (a message may carry several). */
export const answerMessageId = (cardMessage: string, question: string): string => `${cardMessage}:${question}:answer`;

/** The click handler of one instance. */
export function createClickHandler(deps: ClickDeps): ClickHandler {
  const endpoint = deps.credentials.audience;

  return async (key, event, ctx): Promise<ClickOutcome> => {
    const outcome: { handled: HandledEvent } = { handled: "done" };
    const response = await respond(key, event, ctx, outcome);
    return { response, handled: outcome.handled };
  };

  /** The click's response; `outcome.handled` says whether an answer was admitted (or was already). */
  async function respond(key: string, event: AddOnEvent, ctx: AppContext, outcome: { handled: HandledEvent }): Promise<AddOnResponse> {
    const clicked = event.chat.buttonClickedPayload;
    const parameters = event.commonEventObject?.parameters ?? {};
    const dialog = clicked?.isDialogEvent === true || clicked?.dialogEventType !== undefined;
    if (clicked?.dialogEventType === "CANCEL_DIALOG") return CLOSE;

    const user = event.chat.user;
    const space = parseConversationKey(key)?.space;
    if (space === undefined || !deps.credentials.allowedSpaces.has(space) || user === undefined) {
      ctx.logger.warn("channel-google-chat: a click from a space not allowed, or from no user, refused", { conversation: key, space });
      return notice(CLICK_NOTICES.stranger, dialog);
    }
    const id = parameters[CLICK_PARAMETERS.question];
    const record = id === undefined ? undefined : await deps.questions.get(id);
    if (id === undefined || record === undefined) return notice(CLICK_NOTICES.unknown, dialog);
    // The click's key is its action's: a question answers only into the conversation it was drawn in.
    if (record.conversationKey !== key) {
      ctx.logger.warn("channel-google-chat: a click whose key is not its question's conversation, refused", { conversation: key, question: id });
      return notice(CLICK_NOTICES.unknown, dialog);
    }
    if (record.answered !== undefined) return notice(CLICK_NOTICES.answered, dialog);
    // A reset closes the questions asked before it: the key's conversation is another one now, or none.
    const current = await deps.conversations.get(key, ctx);
    if (current === undefined || !record.answerKey.startsWith(`${current.conversationId}:`)) {
      ctx.logger.info("channel-google-chat: a click on a question of a conversation that was reset; nothing admitted", { conversation: key, question: id });
      return notice(CLICK_NOTICES.reset, dialog);
    }

    const step = parameters[CLICK_PARAMETERS.step] as ClickStep | undefined;
    if (step === "open") return { action: { navigations: [{ pushCard: questionDialog(record.question, endpoint, key) }] } };
    if (step !== "answer" && step !== "submit") return notice(CLICK_NOTICES.unknown, dialog);

    const fromForm = step === "submit";
    const answer = fromForm ? formAnswer(record.question.fields, event.commonEventObject?.formInputs ?? {}) : buttonAnswer(record.question.fields, parameters);
    const problem = answerProblem(record.question, answer);
    if (problem !== undefined) {
      const words = `Your answer ${problem}.`;
      if (!fromForm) return notice(words, dialog);
      return { action: { navigations: [{ updateCard: questionDialog(record.question, endpoint, key, { problem: words, answer }) }], notification: { text: words } } };
    }

    // The card's message as it is now: the click's, else read once from Google (a dialog's submit has none).
    let shown: Promise<ChatMessage | undefined> | undefined;
    const cardMessage = (): Promise<ChatMessage | undefined> =>
      (shown ??=
        clicked?.message !== undefined
          ? Promise.resolve(clicked.message)
          : deps.api.getMessage(record.message, ctx.abortSignal).catch((error: unknown) => {
              ctx.logger.warn("channel-google-chat: a question's card could not be read", { question: id, error: String(error) });
              return undefined;
            }));

    // The thread the answer goes to, for a whole chat's conversation: the card's.
    const wholeChat = parseConversationKey(key)?.thread === undefined;
    const thread = wholeChat && spaceOf(event)?.spaceThreadingState !== "UNTHREADED_MESSAGES" ? (await cardMessage())?.thread?.name : undefined;
    const text = answerText(record.question, answer);
    const answerId = answerMessageId(record.message, record.question.id);
    const admitted = await admitInbound(
      ctx,
      { id: answerId, channel: deps.instance.instance, conversationId: space, actor: { id: user.name }, text },
      {
        conversations: deps.conversations,
        runtime: deps.runtime,
        key,
        // The chat's own key, as handler.ts gives every message of the chat.
        space: conversationKey(deps.instance.instance, space),
        // Before the answer can run, as handler.ts records a message's: a failure admits nothing (the click rejects).
        beforeDispatch: async (conversation: ConversationRef) => {
          if (wholeChat) await deps.targets.remember(answerKey(conversation, answerId), thread);
        },
      },
    );

    switch (admitted.kind) {
      case "admitted":
      case "duplicate":
        // A duplicate: the answer is in, and its claim may be missing (a stop between admission and marking): claimed below.
        outcome.handled = admitted.kind;
        break;
      case "denied":
        ctx.logger.info("channel-google-chat: an answer to a question was denied", { conversation: key, question: id, reason: admitted.reason });
        return notice(admitted.reason === undefined ? CLICK_NOTICES.refused : `${CLICK_NOTICES.refused} ${admitted.reason}`, dialog);
      default:
        ctx.logger.warn("channel-google-chat: an answer to a question was not admitted", { conversation: key, question: id, outcome: admitted.kind });
        return notice(CLICK_NOTICES.refused, dialog);
    }

    const name = user.displayName ?? user.name;
    const first = await deps.questions.answer(id, { by: user.name, name, at: deps.clock.now(), text, answer });
    if (!first) return notice(CLICK_NOTICES.answered, dialog);
    const card = answeredCard(record.question, answer, name);
    const message = await cardMessage();
    if (!fromForm && clicked?.message !== undefined) {
      return {
        hostAppDataAction: {
          chatDataAction: { updateMessageAction: { message: { ...(message?.text !== undefined && { text: message.text }), cardsV2: withCard(message?.cardsV2, card) } } },
        },
      };
    }
    // Only the question's card replaced: never without the message's other cards (a table, code).
    if (message === undefined) ctx.logger.warn("channel-google-chat: a question's card is left as it was; its answer is in", { question: id });
    else {
      await deps.api
        .updateMessage(record.message, { cardsV2: withCard(message.cardsV2, card) }, ["cardsV2"], ctx.abortSignal)
        .catch((error: unknown) => ctx.logger.warn("channel-google-chat: a question's card could not be updated; its answer is in", { question: id, error: String(error) }));
    }
    const sent = "Answer sent.";
    return fromForm ? { action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }], notification: { text: sent } } } : { action: { notification: { text: sent } } };
  }
}

/** `cards` with `card` in place of the one with its id (the question's), or `card` alone when there are none. */
function withCard(cards: readonly CardWithId[] | undefined, card: CardWithId): CardWithId[] {
  if (cards === undefined || cards.length === 0) return [card];
  const replaced = cards.map((each) => (each.cardId === card.cardId ? card : each));
  return replaced.includes(card) ? replaced : [...replaced, card];
}

/** A button's answer: its field and its value (`true` / `false` for a confirm). */
function buttonAnswer(fields: readonly QuestionField[], parameters: Record<string, string>): QuestionAnswer {
  const name = parameters[CLICK_PARAMETERS.field];
  const value = parameters[CLICK_PARAMETERS.value];
  if (name === undefined || value === undefined) return {};
  const field = fields.find((each) => each.name === name);
  return { [name]: field?.kind === "confirm" ? confirmed(value) : value };
}

const confirmed = (value: string): QuestionValue => (value === "true" ? true : value === "false" ? false : value);

/** A form's answer, by field name: the values chosen or written, a date as `YYYY-MM-DD` (UTC, as the picker gives it). */
function formAnswer(fields: readonly QuestionField[], inputs: Record<string, FormInput>): QuestionAnswer {
  const answer: QuestionAnswer = {};
  for (const field of fields) {
    const input = inputs[field.name];
    if (input === undefined) continue;
    const values = input.stringInputs?.value ?? [];
    switch (field.kind) {
      case "confirm":
        if (values[0] !== undefined) answer[field.name] = confirmed(values[0]);
        break;
      case "multiselect":
        answer[field.name] = values;
        break;
      case "date": {
        const ms = input.dateInput?.msSinceEpoch ?? input.dateTimeInput?.msSinceEpoch;
        const day = ms === undefined ? values[0] : dayOf(ms);
        if (day !== undefined) answer[field.name] = day;
        break;
      }
      default:
        if (values[0] !== undefined) answer[field.name] = values[0];
    }
  }
  return answer;
}

/** `ms` since the epoch as its UTC day; the text itself when it is no number (answerProblem refuses it). */
function dayOf(ms: string): string {
  const at = Number(ms);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : ms;
}

/** Where a question's record is (`question:<id>`) and where its one answer is claimed. */
const recordKey = (id: string): string => `question:${id}`;
const answeredKey = (id: string): string => `question:${id}:answered`;

/**
 * The questions drawn, in `store` (`question:<id>`), shared by every instance (ids are unique). Each is
 * answered once: the answer is claimed with `setIfAbsent` (`question:<id>:answered`), then written into
 * the record; `get` reads the claim when a stop came in between.
 */
export function createQuestionRecords(store: KeyValueStore): QuestionRecords {
  const claimOf = (id: string) => store.get<JsonValue>(answeredKey(id)) as Promise<QuestionAnswered | undefined>;
  return {
    async sent(record) {
      const existing = (await store.get<JsonValue>(recordKey(record.question.id))) as QuestionRecord | undefined;
      if (existing?.answered !== undefined || (await claimOf(record.question.id)) !== undefined) return;
      await store.set(recordKey(record.question.id), record as unknown as JsonValue);
    },
    async get(id) {
      const record = (await store.get<JsonValue>(recordKey(id))) as QuestionRecord | undefined;
      if (record === undefined || record.answered !== undefined) return record;
      const answered = await claimOf(id);
      return answered === undefined ? record : { ...record, answered };
    },
    async answer(id, answered) {
      if (!(await store.setIfAbsent(answeredKey(id), answered as unknown as JsonValue))) return false;
      const record = (await store.get<JsonValue>(recordKey(id))) as QuestionRecord | undefined;
      if (record !== undefined) await store.set(recordKey(id), { ...record, answered } as unknown as JsonValue);
      return true;
    },
  };
}
