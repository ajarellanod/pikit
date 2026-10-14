// Owner: questions. A `question` part drawn as Google Chat cards and dialogs (features/channel-google-chat.md "Questions").
/**
 * - **One `confirm` or `select` field**: a card (its title, description and label) with a button per
 *   answer (Yes / No, or each option), each calling the app back (`action.function` = `endpoint`, the
 *   app's endpoint URL) with the parameters `CLICK_PARAMETERS` names: the question's id, the field, the
 *   value.
 * - **Anything else**: a card with one button that opens a dialog (`interaction: OPEN_DIALOG`); the
 *   click asks for the dialog (`questionDialog`), a form of the fields (`selectionInput` RADIO_BUTTON /
 *   DROPDOWN for `select`, MULTI_SELECT or CHECK_BOX for `multiselect`, SWITCH or radio for `confirm`,
 *   `textInput`, `dateTimePicker` DATE_ONLY), and its submit button calls back with the question's id.
 * - `answeredCard`: the card once answered, its buttons gone, saying who answered what.
 *
 * click.ts reads the parameters back (`CLICK_PARAMETERS`) and the form (`formInputs`, by field name).
 */

import type { QuestionAnswer, QuestionPart } from "@pikit/contracts";
import type { Card, CardWithId } from "./event.ts";

/** The `action.parameters` keys of a question's buttons. */
export const CLICK_PARAMETERS = {
  /** The question's id. */
  question: "question",
  /** What the click asks: `answer` (a button's value), `open` (the dialog), `submit` (the dialog's form). */
  step: "step",
  /** A button's field name. */
  field: "field",
  /** A button's value (`true` / `false` for a confirm). */
  value: "value",
} as const;

/** `question` as its message's card (above), its buttons calling `endpoint`. */
export function questionCard(question: QuestionPart, endpoint: string): CardWithId {
  void question;
  void endpoint;
  throw new Error("not implemented: questions (question-cards.ts questionCard)");
}

/** The dialog of `question`'s form, its submit button calling `endpoint`. */
export function questionDialog(question: QuestionPart, endpoint: string): Card {
  void question;
  void endpoint;
  throw new Error("not implemented: questions (question-cards.ts questionDialog)");
}

/** `question`'s card once answered by `by` (a display name) with `answer`: no buttons, the answer said. */
export function answeredCard(question: QuestionPart, answer: QuestionAnswer, by: string): CardWithId {
  void question;
  void answer;
  void by;
  throw new Error("not implemented: questions (question-cards.ts answeredCard)");
}
