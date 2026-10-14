/**
 * The `question` part (`parts.ts`): a question the agent asks the person it talks to, drawn by a channel
 * that can (Google Chat's cards and dialogs) and sent as its `fallback` text by any other.
 *
 * Shared vocabulary, so it is declared here and not by a component: the one that asks (the tool
 * `askUser`, `tool-ask-user`) and the ones that draw it and admit its answer (channels) must not know
 * each other (features/approvals.md: "what is asked is shared vocabulary, in @pikit/contracts"). The
 * core (`@pikit/core`) still declares no kind of part; a kind only one component and its own drawer
 * use is that component's to declare.
 *
 * - **A question** has an id (`<conversation id>:<request id>:<tool call id>` for `askUser`), a
 *   title, an optional description and its fields, each named, with a label: `confirm` (yes or no),
 *   `select` (one of its options), `multiselect` (any of them), `text` and `date` (`YYYY-MM-DD`).
 * - **Its answer comes back as an ordinary message** whose text says it in words (`answerText`): what
 *   the model reads is the whole answer, the same whether a person clicked a button or typed it back
 *   to the fallback. No field of `InboundMessage` carries it.
 *
 * The helpers are the protocol both sides share: `questionProblem` (the one check of a question),
 * `questionPart` (a question with its fallback, `questionFallback`), `answerProblem` and
 * `answerText`. How a question is drawn, who may answer it and how often are the channel's.
 */

/** One option of a `select` or `multiselect` field: what the answer carries (`value`) and what a person reads (`label`). */
export interface QuestionOption {
  value: string;
  label: string;
}

/** What every field has: a name, unique in its question (the answer's key), and a label a person reads. */
interface FieldBase {
  name: string;
  label: string;
  /** The answer must give it. Absent: optional. */
  required?: boolean;
}

/** One field of a question, by its `kind`. */
export type QuestionField =
  /** Yes or no: answered `true` or `false`. */
  | (FieldBase & { kind: "confirm" })
  /** One of `options`: answered with its `value`. */
  | (FieldBase & { kind: "select"; options: QuestionOption[] })
  /** Any of `options`: answered with their `value`s, in the options' order. */
  | (FieldBase & { kind: "multiselect"; options: QuestionOption[] })
  /** Free text. */
  | (FieldBase & { kind: "text" })
  /** A day: answered `YYYY-MM-DD`. */
  | (FieldBase & { kind: "date" });

/** The kinds of field (`QuestionField.kind`). */
export const QUESTION_FIELD_KINDS = ["confirm", "select", "multiselect", "text", "date"] as const;

/** A question, without its part's `type` and `fallback`. */
export interface Question {
  /** Unique where it is asked: `askUser`'s is `<conversation id>:<request id>:<tool call id>`. */
  id: string;
  title: string;
  description?: string;
  /** At least one. */
  fields: QuestionField[];
}

declare module "./parts.ts" {
  interface AppMessageParts {
    /** A question to the person the answer goes to (`question.ts`). */
    question: Question;
  }
}

/** A `question` part: the question, its `type` and its `fallback`. */
export type QuestionPart = { type: "question"; fallback: string } & Question;

/** A field's answer: `confirm` a boolean, `select`, `text` and `date` a string, `multiselect` the values chosen. */
export type QuestionValue = boolean | string | string[];

/** An answer to a question: each field's value by its name; an optional field may be absent. */
export type QuestionAnswer = Record<string, QuestionValue | undefined>;

/** A field's name: a letter, then letters, digits, `_` or `-`. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A date answer. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What is wrong with `question` (any value: a model's tool arguments, a part read back from JSON), or
 * `undefined` when it is a question: an id and a title (non-empty text), a description (text) or none,
 * one field or more, each of a known kind, with a unique name (`FIELD_NAME`), a label, `required` a
 * boolean or absent, and options (one or more, unique non-empty values, each labelled) exactly on
 * `select` and `multiselect`.
 */
export function questionProblem(question: unknown): string | undefined {
  if (!isObject(question)) return "is not an object";
  if (!isText(question.id)) return "has no id (non-empty text)";
  if (!isText(question.title)) return "has no title (non-empty text)";
  if (question.description !== undefined && typeof question.description !== "string") return "has a description that is not text";
  if (!Array.isArray(question.fields) || question.fields.length === 0) return "has no fields (one or more)";
  const names = new Set<string>();
  for (const [index, field] of question.fields.entries()) {
    const problem = fieldProblem(field, names);
    if (problem !== undefined) return `field ${index} ${problem}`;
  }
  return undefined;
}

function fieldProblem(field: unknown, names: Set<string>): string | undefined {
  if (!isObject(field)) return "is not an object";
  if (typeof field.kind !== "string" || !(QUESTION_FIELD_KINDS as readonly string[]).includes(field.kind)) return `has no kind (one of ${QUESTION_FIELD_KINDS.join(", ")})`;
  if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return "has no name (a letter, then letters, digits, _ or -)";
  if (names.has(field.name)) return `has the name "${field.name}" of another field`;
  names.add(field.name);
  if (!isText(field.label)) return `"${field.name}" has no label (non-empty text)`;
  if (field.required !== undefined && typeof field.required !== "boolean") return `"${field.name}" has a required that is not a boolean`;
  const choosing = field.kind === "select" || field.kind === "multiselect";
  if (!choosing) return field.options === undefined ? undefined : `"${field.name}" is ${field.kind}, which has no options`;
  if (!Array.isArray(field.options) || field.options.length === 0) return `"${field.name}" has no options (one or more)`;
  const values = new Set<string>();
  for (const [index, option] of field.options.entries()) {
    if (!isObject(option) || !isText(option.value) || !isText(option.label)) return `"${field.name}" option ${index} has no value or label (non-empty text)`;
    if (values.has(option.value)) return `"${field.name}" has the option value "${option.value}" twice`;
    values.add(option.value);
  }
  return undefined;
}

/**
 * The text a reader is given where `question` is not drawn: its title, its description, each field
 * with what it takes (its options' labels and values), and how to answer: in a reply, in words.
 */
export function questionFallback(question: Question): string {
  const lines = [`**${question.title}**`];
  if (question.description !== undefined && question.description.trim() !== "") lines.push("", question.description.trim());
  lines.push("");
  for (const field of question.fields) lines.push(`- ${field.label}${field.required === true ? "" : " (optional)"}: ${takes(field)}`);
  lines.push("", "Reply with your answer in a message.");
  return lines.join("\n");
}

function takes(field: QuestionField): string {
  const options = (choices: QuestionOption[]) => choices.map((option) => (option.label === option.value ? option.label : `${option.label} (${option.value})`)).join(", ");
  switch (field.kind) {
    case "confirm":
      return "yes or no";
    case "select":
      return `one of ${options(field.options)}`;
    case "multiselect":
      return `any of ${options(field.options)}`;
    case "text":
      return "text";
    case "date":
      return "a date (YYYY-MM-DD)";
  }
}

/** `question` as a part, its fallback written by `questionFallback`. Throws a `TypeError` when it is not a question (`questionProblem`). */
export function questionPart(question: Question): QuestionPart {
  const problem = questionProblem(question);
  if (problem !== undefined) throw new TypeError(`question: the question ${problem}`);
  return { type: "question", fallback: questionFallback(question), ...question };
}

/**
 * What is wrong with `answer` to `question`, or `undefined`: every required field answered, each value
 * of its field's kind (`QuestionValue`), a `select`'s and every `multiselect` value among its options,
 * a date `YYYY-MM-DD`, and no value for a field the question does not have. An empty text or an empty
 * `multiselect` counts as no answer.
 */
export function answerProblem(question: Question, answer: QuestionAnswer): string | undefined {
  const fields = new Map(question.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(answer)) if (answer[name] !== undefined && !fields.has(name)) return `answers "${name}", which the question does not ask`;
  for (const field of question.fields) {
    const value = answer[field.name];
    if (isEmpty(value)) {
      if (field.required === true) return `does not answer "${field.label}", which is required`;
      continue;
    }
    const problem = valueProblem(field, value as QuestionValue);
    if (problem !== undefined) return `answers "${field.label}" with ${problem}`;
  }
  return undefined;
}

const isEmpty = (value: QuestionValue | undefined): boolean => value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);

function valueProblem(field: QuestionField, value: QuestionValue): string | undefined {
  switch (field.kind) {
    case "confirm":
      return typeof value === "boolean" ? undefined : "something other than yes or no";
    case "select":
      return typeof value === "string" && field.options.some((option) => option.value === value) ? undefined : "a value that is not one of its options";
    case "multiselect":
      return Array.isArray(value) && value.every((each) => field.options.some((option) => option.value === each)) ? undefined : "values that are not among its options";
    case "text":
      return typeof value === "string" ? undefined : "something other than text";
    case "date":
      return typeof value === "string" && DATE.test(value) ? undefined : "something other than a date (YYYY-MM-DD)";
  }
}

/**
 * `answer` to `question` as the text of the message that brings it back, for the model: "Answer to"
 * the question's title and id, then each field's label and value (an option's label with its value, yes
 * or no, "no answer" for an optional field left empty). Not checked: call `answerProblem` first.
 */
export function answerText(question: Question, answer: QuestionAnswer): string {
  const lines = [`Answer to "${question.title}" (question ${question.id}):`];
  for (const field of question.fields) lines.push(`- ${field.label}: ${said(field, answer[field.name])}`);
  return lines.join("\n");
}

function said(field: QuestionField, value: QuestionValue | undefined): string {
  if (isEmpty(value)) return "no answer";
  const option = (choice: string) => {
    const found = "options" in field ? field.options.find((each) => each.value === choice) : undefined;
    return found === undefined || found.label === found.value ? choice : `${found.label} (${found.value})`;
  };
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(option).join(", ");
  return field.kind === "select" ? option(value as string) : (value as string);
}
