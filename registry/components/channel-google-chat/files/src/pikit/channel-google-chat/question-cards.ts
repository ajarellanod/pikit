// Owner: questions. A `question` part drawn as Google Chat cards and dialogs (features/channel-google-chat.md "Questions").
/**
 * - **One `confirm` or `select` field**: a card (its title, description and label) with a button per
 *   answer (Yes / No, or each option), each calling the app back (`action.function` = `endpoint`, the
 *   app's endpoint URL) with the parameters `CLICK_PARAMETERS` names: the question's id, the step
 *   (`answer`), the field, the value.
 * - **Anything else**: a card with one button that opens a dialog (`interaction: OPEN_DIALOG`, step
 *   `open`); the click asks for the dialog (`questionDialog`), a form of the fields and a button that
 *   sends it (step `submit`, the question's id):
 *   - `confirm`: `selectionInput` RADIO_BUTTON, Yes (`true`) / No (`false`): an explicit answer, so a
 *     required one can be left unanswered and told (a SWITCH is always one or the other);
 *   - `select`: RADIO_BUTTON, DROPDOWN past `RADIO_OPTIONS` options;
 *   - `multiselect`: CHECK_BOX, MULTI_SELECT past `RADIO_OPTIONS` options;
 *   - `text`: `textInput` MULTIPLE_LINE; `date`: `dateTimePicker` DATE_ONLY.
 *   A form sent back with a problem is drawn again (`retry`) with the problem on top and what was
 *   answered kept.
 * - `answeredCard`: the card once answered, its buttons gone, saying who answered what.
 *
 * Each widget's name is its field's name: click.ts reads the parameters back (`CLICK_PARAMETERS`) and
 * the form (`formInputs`, by field name). A card's id (`questionCardId`) is the question's, so the
 * answered card replaces the question's own in its message. Text a card shows as formatted text
 * (`textParagraph`, `decoratedText`) is escaped (`&`, `<`, `>`): a card's text is HTML to Google.
 */

import type { QuestionAnswer, QuestionField, QuestionPart, QuestionValue } from "@pikit/contracts";
import type { Card, CardButton, CardWidget, CardWithId } from "./event.ts";

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

/** The steps a click asks for (`CLICK_PARAMETERS.step`). */
export type ClickStep = "answer" | "open" | "submit";

/** Up to this many options, a select is radio buttons and a multiselect checkboxes; past it, a menu. */
export const RADIO_OPTIONS = 5;

/** What a confirm's Yes and No carry. */
const YES = "true";
const NO = "false";

/** The card id of `question`'s card, in its message and once answered. */
export const questionCardId = (question: Pick<QuestionPart, "id">): string => `question:${question.id}`;

/** Whether `question` is drawn as buttons (one `confirm` or `select` field), not as a dialog. */
export function drawnAsButtons(question: Pick<QuestionPart, "fields">): boolean {
  const [only, ...more] = question.fields;
  return only !== undefined && more.length === 0 && (only.kind === "confirm" || only.kind === "select");
}

/** `text` as a card's formatted text shows it: as it is. */
export const escapeCardText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const parameters = (question: QuestionPart, step: ClickStep, more: Record<string, string> = {}) =>
  Object.entries({ [CLICK_PARAMETERS.question]: question.id, [CLICK_PARAMETERS.step]: step, ...more }).map(([key, value]) => ({ key, value }));

const header = (question: QuestionPart, subtitle?: string): NonNullable<Card["header"]> => ({ title: question.title, ...(subtitle !== undefined && { subtitle }) });

const paragraph = (text: string): CardWidget => ({ textParagraph: { text } });

/** The description, as the first widget; none when there is none. */
const described = (question: QuestionPart): CardWidget[] =>
  question.description === undefined || question.description.trim() === "" ? [] : [paragraph(escapeCardText(question.description.trim()))];

/** A field's label as a form shows it: "(optional)" after an optional one, as the fallback says it. */
const labelOf = (field: QuestionField): string => (field.required === true ? field.label : `${field.label} (optional)`);

/** `question` as its message's card (above), its buttons calling `endpoint`. */
export function questionCard(question: QuestionPart, endpoint: string): CardWithId {
  const widgets = described(question);
  const field = question.fields[0];
  if (drawnAsButtons(question) && field !== undefined && (field.kind === "confirm" || field.kind === "select")) {
    const answers = field.kind === "confirm" ? [{ label: "Yes", value: YES }, { label: "No", value: NO }] : field.options;
    const buttons: CardButton[] = answers.map((answer) => ({
      text: answer.label,
      onClick: { action: { function: endpoint, parameters: parameters(question, "answer", { [CLICK_PARAMETERS.field]: field.name, [CLICK_PARAMETERS.value]: answer.value }) } },
    }));
    widgets.push(paragraph(`<b>${escapeCardText(field.label)}</b>`), { buttonList: { buttons } });
  } else {
    widgets.push(
      paragraph(question.fields.map((each) => `• ${escapeCardText(labelOf(each))}`).join("<br>")),
      { buttonList: { buttons: [{ text: "Answer", onClick: { action: { function: endpoint, interaction: "OPEN_DIALOG", parameters: parameters(question, "open") } } }] } },
    );
  }
  return { cardId: questionCardId(question), card: { header: header(question), sections: [{ widgets }] } };
}

/** What a form sent back with a problem is drawn again with: the problem, and what was answered. */
export interface DialogRetry {
  problem: string;
  answer: QuestionAnswer;
}

/** The dialog of `question`'s form, its submit button calling `endpoint`; `retry`: drawn again with a problem on top, the answers kept. */
export function questionDialog(question: QuestionPart, endpoint: string, retry?: DialogRetry): Card {
  const widgets = described(question);
  if (retry !== undefined) widgets.push(paragraph(`<font color="#d93025">${escapeCardText(retry.problem)}</font>`));
  for (const field of question.fields) widgets.push(inputOf(field, retry?.answer[field.name]));
  widgets.push({ buttonList: { buttons: [{ text: "Send", type: "FILLED", onClick: { action: { function: endpoint, parameters: parameters(question, "submit") } } }] } });
  return { header: header(question), sections: [{ widgets }] };
}

/** A field's input, with `value` given back when the form is drawn again. */
function inputOf(field: QuestionField, value: QuestionValue | undefined): CardWidget {
  const label = labelOf(field);
  const chosen = (each: string) => (Array.isArray(value) ? value.includes(each) : value === each);
  switch (field.kind) {
    case "confirm":
      return {
        selectionInput: {
          name: field.name,
          label,
          type: "RADIO_BUTTON",
          items: [
            { text: "Yes", value: YES, selected: value === true },
            { text: "No", value: NO, selected: value === false },
          ],
        },
      };
    case "select":
    case "multiselect": {
      const many = field.options.length > RADIO_OPTIONS;
      const type = field.kind === "select" ? (many ? "DROPDOWN" : "RADIO_BUTTON") : many ? "MULTI_SELECT" : "CHECK_BOX";
      return { selectionInput: { name: field.name, label, type, items: field.options.map((option) => ({ text: option.label, value: option.value, selected: chosen(option.value) })) } };
    }
    case "text":
      return { textInput: { name: field.name, label, type: "MULTIPLE_LINE", ...(typeof value === "string" && { value }) } };
    case "date": {
      const at = typeof value === "string" ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
      return { dateTimePicker: { name: field.name, label, type: "DATE_ONLY", ...(Number.isFinite(at) && { valueMsEpoch: String(at) }) } };
    }
  }
}

/** A field's answer as a person reads it: yes or no, the options' labels, the text, the date; "no answer". */
export function answerShown(field: QuestionField, value: QuestionValue | undefined): string {
  if (value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)) return "No answer";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const label = (choice: string) => ("options" in field ? (field.options.find((option) => option.value === choice)?.label ?? choice) : choice);
  return Array.isArray(value) ? value.map(label).join(", ") : label(value);
}

/** `question`'s card once answered by `by` (a display name) with `answer`: no buttons, the answer said. */
export function answeredCard(question: QuestionPart, answer: QuestionAnswer, by: string): CardWithId {
  const widgets = described(question);
  for (const field of question.fields) widgets.push({ decoratedText: { topLabel: field.label, text: escapeCardText(answerShown(field, answer[field.name])), wrapText: true } });
  return { cardId: questionCardId(question), card: { header: header(question, `Answered by ${by}`), sections: [{ widgets }] } };
}
