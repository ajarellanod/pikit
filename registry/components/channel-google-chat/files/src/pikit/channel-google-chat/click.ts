// Owner: questions. A question's click or form, answered and admitted (features/channel-google-chat.md "Questions").
/**
 * The same code on both targets: on a server the route calls it in process, on Cloudflare the
 * conversation's object answers `google-chat.click` (`actor.inbox.answer`).
 *
 * - The click's parameters (question-cards.ts `CLICK_PARAMETERS`) name the question; its record
 *   (`QuestionRecords.get`) says its card's message and conversation. Unknown: the click is answered
 *   with a notice (the question is not known here), nothing admitted.
 * - `open`: the dialog (`questionDialog`), as `action.navigations[0].pushCard`.
 * - `answer` / `submit`: the answer read from the parameters or `formInputs` (`stringInputs`,
 *   `dateInput` as `YYYY-MM-DD`), checked (`answerProblem` from `@pikit/contracts`: a problem is
 *   answered as a notice, the dialog kept open). The first one to answer (`QuestionRecords.answer`)
 *   is admitted (`admitInbound`) as a message whose text is `answerText(question, answer)`, from the
 *   clicker (`actor.id` their `users/…`), id `<card message name>:answer` (a click Google repeats is
 *   a `duplicate`), its answer's thread recorded as handler.ts records it; the card is updated to
 *   `answeredCard` (`updateMessageAction`, or for a dialog `endNavigation` and the card updated by
 *   `api.updateMessage`). A question already answered answers the click with who answered it, and
 *   admits nothing.
 * - Anyone the channel admits in the conversation may answer; a question stays open until answered
 *   or the conversation is reset (a reset does not delete the record: its conversation is gone).
 *
 * Rejects only when a capability failed (the route answers 500).
 */

import type { KeyValueStore } from "@pikit/contracts";
import type { AdmissionDeps, ClickHandler, QuestionRecords } from "./types.ts";

export interface ClickDeps extends AdmissionDeps {
  questions: QuestionRecords;
}

/** The click handler of one instance. */
export function createClickHandler(deps: ClickDeps): ClickHandler {
  void deps;
  return async () => {
    throw new Error("not implemented: questions (click.ts createClickHandler)");
  };
}

/** The questions drawn, in `store` (`question:<id>`), shared by every instance (ids are unique). */
export function createQuestionRecords(store: KeyValueStore): QuestionRecords {
  void store;
  const missing = async (): Promise<never> => {
    throw new Error("not implemented: questions (click.ts createQuestionRecords)");
  };
  return { sent: missing, get: missing, answer: missing };
}
