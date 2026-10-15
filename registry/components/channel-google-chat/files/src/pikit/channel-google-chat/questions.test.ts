// Owner: questions. Cards, dialogs, clicks and answers (question-cards.ts, click.ts).
/**
 * channel-google-chat's questions. They are copied with the component and keep running in your project.
 *
 * - question-cards.ts: one `confirm` or `select` field as buttons, anything else as a button that opens
 *   a dialog with the form, and the card once answered.
 * - click.ts against stand-ins for Google's API, the registry and the runtime (a runtime that answers
 *   `duplicate` for a request it has, as runtime-pi does), in an App with a router: an answer admitted
 *   once, its text `answerText`, the card updated; a second click, an unknown question, a stranger
 *   space, a refused answer, a cancelled dialog, a question of a conversation that was reset; the
 *   records answered once.
 */

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import {
  type AgentRequest,
  type AgentRuntime,
  answerKey,
  answerText,
  type ConversationRef,
  type ConversationRegistry,
  type QuestionPart,
  questionPart,
} from "@pikit/contracts";
import { createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import { answerMessageId, CLICK_NOTICES, createClickHandler, createQuestionRecords } from "./click.ts";
import type { AddOnEvent, AddOnResponse, Card, CardWidget, CardWithId, ChatMessage } from "./event.ts";
import { type ClickEventOptions, clickEvent, dateInput, PERSON, textInput } from "./fake-google-chat.test-support.ts";
import { type Credentials, instancesOf } from "./instance.ts";
import { createSpaceThreading, eventKey } from "./key.ts";
import { answeredCard, CLICK_PARAMETERS, drawnAsButtons, drawnQuestion, questionCard, questionCardId, questionDialog, RADIO_OPTIONS } from "./question-cards.ts";
import type { AnswerTargets, ChatApi, HandledEvent, MessageField, QuestionRecords } from "./types.ts";

const ENDPOINT = "https://pikit.test/google-chat";
const SPACE = "spaces/AAA";
const THREAD = `${SPACE}/threads/T1`;
const CARD_MESSAGE = `${SPACE}/messages/client-abc`;
const THREAD_KEY = `googlechat:${SPACE}:threads/T1`;
const CHAT_KEY = `googlechat:${SPACE}`;
/** The answer that drew the questions: asked in the conversation `s1` (the subject's first). */
const ASKED_IN = "s1:spaces/AAA/messages/m1";
const OTHER_SPACE = "spaces/BBB";
const GRACE: typeof PERSON = { name: "users/1002", displayName: "Grace Hopper", type: "HUMAN" };

const confirm = questionPart({ id: "c1:m1:call-1", title: "Deploy now?", description: "The build <passed> & is green.", fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }] });
const select = questionPart({
  id: "c1:m1:call-2",
  title: "Which environment?",
  fields: [{ kind: "select", name: "env", label: "Environment", required: true, options: [{ value: "prod", label: "Production" }, { value: "staging", label: "Staging" }] }],
});
const form = questionPart({
  id: "c1:m1:call-3",
  title: "Plan the release",
  fields: [
    { kind: "text", name: "notes", label: "Notes", required: true },
    { kind: "multiselect", name: "regions", label: "Regions", options: [{ value: "eu", label: "Europe" }, { value: "us", label: "Americas" }] },
    { kind: "date", name: "day", label: "Day", required: true },
    { kind: "confirm", name: "notify", label: "Notify customers" },
    { kind: "select", name: "size", label: "Size", options: Array.from({ length: RADIO_OPTIONS + 1 }, (_, i) => ({ value: `s${i}`, label: `Size ${i}` })) },
  ],
});

const widgets = (card: Card): CardWidget[] => card.sections?.flatMap((section) => section.widgets) ?? [];
const buttonsOf = (card: Card) => widgets(card).flatMap((widget) => widget.buttonList?.buttons ?? []);
const params = (list: { key: string; value: string }[] | undefined) => Object.fromEntries((list ?? []).map((each) => [each.key, each.value]));

// ---------------------------------------------------------------------------------------------------
// question-cards.ts

test("one confirm field: a card with Yes and No, each calling the endpoint with the conversation's key, the question, the field and its value; the text escaped", () => {
  expect(drawnAsButtons(confirm)).toBe(true);
  const { cardId, card } = questionCard(confirm, ENDPOINT, THREAD_KEY);
  expect(cardId).toBe(questionCardId(confirm));
  expect(card.header).toEqual({ title: "Deploy now?" });
  expect(widgets(card)[0]).toEqual({ textParagraph: { text: "The build &lt;passed&gt; &amp; is green." } });
  expect(buttonsOf(card).map((button) => [button.text, button.onClick.action?.function, params(button.onClick.action?.parameters)])).toEqual([
    ["Yes", ENDPOINT, { key: THREAD_KEY, question: confirm.id, step: "answer", field: "go", value: "true" }],
    ["No", ENDPOINT, { key: THREAD_KEY, question: confirm.id, step: "answer", field: "go", value: "false" }],
  ]);
});

test("one select field: a button per option, its label shown and its value carried", () => {
  const { card } = questionCard(select, ENDPOINT, THREAD_KEY);
  expect(buttonsOf(card).map((button) => [button.text, params(button.onClick.action?.parameters)[CLICK_PARAMETERS.value]])).toEqual([
    ["Production", "prod"],
    ["Staging", "staging"],
  ]);
  expect(buttonsOf(card).every((button) => button.onClick.action?.interaction === undefined)).toBe(true);
});

test("anything else: one button that opens the dialog, the fields listed", () => {
  expect(drawnAsButtons(form)).toBe(false);
  expect(drawnAsButtons({ fields: [{ kind: "text", name: "a", label: "A" }] })).toBe(false);
  const { card } = questionCard(form, ENDPOINT, CHAT_KEY);
  const [button, ...more] = buttonsOf(card);
  expect(more).toEqual([]);
  expect(button?.onClick.action).toEqual({
    function: ENDPOINT,
    interaction: "OPEN_DIALOG",
    parameters: [
      { key: "key", value: CHAT_KEY },
      { key: "question", value: form.id },
      { key: "step", value: "open" },
    ],
  });
  expect(widgets(card)[0]?.textParagraph?.text).toContain("• Notes<br>• Regions (optional)");
});

test("the dialog: an input per field by its kind, named after it, and a button that sends the form", () => {
  const dialog = questionDialog(form, ENDPOINT, CHAT_KEY);
  const inputs = widgets(dialog).filter((widget) => widget.buttonList === undefined);
  expect(inputs).toEqual([
    { textInput: { name: "notes", label: "Notes", type: "MULTIPLE_LINE" } },
    {
      selectionInput: {
        name: "regions",
        label: "Regions (optional)",
        type: "CHECK_BOX",
        items: [
          { text: "Europe", value: "eu", selected: false },
          { text: "Americas", value: "us", selected: false },
        ],
      },
    },
    { dateTimePicker: { name: "day", label: "Day", type: "DATE_ONLY" } },
    {
      selectionInput: {
        name: "notify",
        label: "Notify customers (optional)",
        type: "RADIO_BUTTON",
        items: [
          { text: "Yes", value: "true", selected: false },
          { text: "No", value: "false", selected: false },
        ],
      },
    },
    expect.objectContaining({ selectionInput: expect.objectContaining({ name: "size", type: "DROPDOWN" }) }) as never,
  ]);
  const [send] = buttonsOf(dialog);
  expect(params(send?.onClick.action?.parameters)).toEqual({ key: CHAT_KEY, question: form.id, step: "submit" });
  const many = questionPart({ id: "q", title: "T", fields: [{ kind: "multiselect", name: "m", label: "M", options: Array.from({ length: RADIO_OPTIONS + 1 }, (_, i) => ({ value: `v${i}`, label: `V${i}` })) }] });
  expect(widgets(questionDialog(many, ENDPOINT, CHAT_KEY))[0]?.selectionInput?.type).toBe("MULTI_SELECT");
  expect(widgets(questionDialog(select, ENDPOINT, CHAT_KEY))[0]?.selectionInput?.type).toBe("RADIO_BUTTON");
});

test("every action carries the conversation's key (the route keys a click by it: a dialog's has no message)", () => {
  const cards = [questionCard(confirm, ENDPOINT, THREAD_KEY).card, questionCard(select, ENDPOINT, THREAD_KEY).card, questionCard(form, ENDPOINT, THREAD_KEY).card];
  const dialogs = [questionDialog(form, ENDPOINT, THREAD_KEY), questionDialog(form, ENDPOINT, THREAD_KEY, { problem: "x", answer: {} })];
  const actions = [...cards, ...dialogs].flatMap(buttonsOf).map((button) => button.onClick.action);
  expect(actions).toHaveLength(2 + 2 + 1 + 2);
  for (const action of actions) expect(params(action?.parameters)[CLICK_PARAMETERS.key]).toBe(THREAD_KEY);
  expect(CLICK_PARAMETERS.key).toBe("key");
});

test("the dialog drawn again: the problem on top, what was answered kept", () => {
  const dialog = questionDialog(form, ENDPOINT, CHAT_KEY, { problem: "Your answer is <wrong>.", answer: { notes: "ship it", regions: ["us"], day: "2026-03-01", notify: false } });
  const [problem, notes, regions, day, notify] = widgets(dialog);
  expect(problem?.textParagraph?.text).toContain("Your answer is &lt;wrong&gt;.");
  expect(notes?.textInput?.value).toBe("ship it");
  expect(regions?.selectionInput?.items.map((item) => item.selected)).toEqual([false, true]);
  expect(day?.dateTimePicker?.valueMsEpoch).toBe(String(Date.parse("2026-03-01T00:00:00Z")));
  expect(notify?.selectionInput?.items.map((item) => item.selected)).toEqual([false, true]);
});

test("the answered card: no buttons, who answered, each field's answer as a person reads it", () => {
  const { cardId, card } = answeredCard(form, { notes: "a & b", regions: ["eu", "us"], day: "2026-03-01", notify: true }, "Ada Lovelace");
  expect(cardId).toBe(questionCardId(form));
  expect(card.header).toEqual({ title: "Plan the release", subtitle: "Answered by Ada Lovelace" });
  expect(buttonsOf(card)).toEqual([]);
  expect(widgets(card).map((widget) => [widget.decoratedText?.topLabel, widget.decoratedText?.text])).toEqual([
    ["Notes", "a &amp; b"],
    ["Regions", "Europe, Americas"],
    ["Day", "2026-03-01"],
    ["Notify customers", "Yes"],
    ["Size", "No answer"],
  ]);
});

test("drawnQuestion: its card with buttons; once answered (its piece sent again), the answered card", () => {
  expect(drawnQuestion(confirm, ENDPOINT, THREAD_KEY)).toEqual(questionCard(confirm, ENDPOINT, THREAD_KEY));
  const answered = { by: PERSON.name, name: "Ada Lovelace", at: 1, text: "no", answer: { go: false } };
  expect(drawnQuestion(confirm, ENDPOINT, THREAD_KEY, answered)).toEqual(answeredCard(confirm, { go: false }, "Ada Lovelace"));
});

// ---------------------------------------------------------------------------------------------------
// click.ts

interface Setup {
  router?: "allow" | "deny";
  /** Recording a whole chat's answer thread fails (`targets.remember`). */
  rememberFails?: boolean;
  /** The runtime's dispatch throws this many times first (a capability failing). */
  failures?: number;
}

async function subject(setup: Setup = {}) {
  const app = await defineApp({
    components: [
      defineComponent({
        name: "router-test",
        setup: (pikit) =>
          pikit.pipeline("route.resolve", (value) =>
            value.decision !== undefined ? value : { ...value, decision: { agent: "assistant", access: setup.router ?? "allow", ...(setup.router === "deny" && { reason: "Not today." }) } },
          ),
      }),
    ],
    logger: silentLogger,
  }).create();
  const ctx = app.context() as AppContext;

  let sessions = 0;
  const pointers = new Map<string, ConversationRef>();
  const conversations = {
    resolve: async (key: string, agent: string) => pointers.get(key) ?? (pointers.set(key, { key, agent, conversationId: `s${++sessions}` }), pointers.get(key)!),
    get: async (key: string) => pointers.get(key),
    reset: async () => undefined,
  } as unknown as ConversationRegistry;

  let failures = setup.failures ?? 0;
  const seen = new Set<string>();
  const dispatched: AgentRequest[] = [];
  const runtime = {
    async dispatch(request: AgentRequest) {
      if (failures-- > 0) throw new Error("storage down");
      dispatched.push(request);
      if (seen.has(request.requestId)) return { kind: "duplicate", requestId: request.requestId };
      seen.add(request.requestId);
      return { kind: "started", requestId: request.requestId };
    },
  } as unknown as AgentRuntime;

  const remembered: [string, string | undefined][] = [];
  const targets: AnswerTargets = {
    remember: async (key, thread) => {
      if (setup.rememberFails === true) throw new Error("storage down");
      remembered.push([key, thread]);
    },
    of: async () => undefined,
  };
  const updated: { name: string; message: ChatMessage; fields: readonly MessageField[] }[] = [];
  const read: string[] = [];
  const messages = new Map<string, ChatMessage>();
  const unexpected = async (): Promise<never> => {
    throw new Error("not expected in these tests");
  };
  const api: ChatApi = {
    createMessage: unexpected,
    deleteMessage: unexpected,
    getSpace: unexpected,
    downloadMedia: unexpected,
    async updateMessage(name, message, fields) {
      updated.push({ name, message, fields });
      return { ...messages.get(name), ...message };
    },
    async getMessage(name) {
      read.push(name);
      const found = messages.get(name);
      if (found === undefined) throw new Error("not found");
      return found;
    },
  };

  const store = createMemoryKeyValueStorage().namespace("channel-google-chat");
  const questions = createQuestionRecords(store);
  const [instance] = instancesOf([]);
  const credentials = { audience: ENDPOINT, allowedSpaces: new Set([SPACE, OTHER_SPACE]) } as unknown as Credentials;
  const handler = createClickHandler({
    instance: instance!,
    credentials,
    api,
    targets,
    conversations,
    runtime,
    store,
    workspace: undefined,
    execution: undefined,
    clock: { now: () => 1_000 } as AppContext["clock"],
    questions,
  });

  /** What each click led to (`ClickOutcome.handled`): index.ts wakes answer delivery after an answer admitted. */
  const handled: HandledEvent[] = [];
  const click = async (key: string, event: AddOnEvent, ctx: AppContext): Promise<AddOnResponse> => {
    const outcome = await handler(key, event, ctx);
    handled.push(outcome.handled);
    return outcome.response;
  };

  /**
   * `questions` drawn in the card message after a table card, as the transport records them, asked in
   * the conversation `s1` of `conversationKey` (made so when it has none); its message as Google has it.
   */
  const drawn = async (question: QuestionPart | QuestionPart[], conversationKey = THREAD_KEY): Promise<ChatMessage> => {
    const asked = Array.isArray(question) ? question : [question];
    if (!pointers.has(conversationKey)) pointers.set(conversationKey, { key: conversationKey, agent: "assistant", conversationId: "s1" });
    const message: ChatMessage = {
      name: CARD_MESSAGE,
      text: "Here is my question.",
      thread: { name: THREAD },
      cardsV2: [{ cardId: "table-1", card: { sections: [{ widgets: [{ textParagraph: { text: "a table" } }] }] } }, ...asked.map((each) => questionCard(each, ENDPOINT, conversationKey))],
    };
    messages.set(CARD_MESSAGE, message);
    for (const each of asked) await questions.sent({ question: each, message: CARD_MESSAGE, conversationKey, answerKey: ASKED_IN });
    return message;
  };
  return { ctx, click, handled, dispatched, remembered, updated, read, questions, store, drawn, conversations: pointers, seen, messages };
}

const press = (question: QuestionPart, message: ChatMessage | undefined, field: string, value: string, user = PERSON): AddOnEvent =>
  clickEvent({ ...(message !== undefined && { message }), user, invokedFunction: ENDPOINT, parameters: { question: question.id, step: "answer", field, value } });

const updatedCards = (response: AddOnResponse): CardWithId[] | undefined => response.hostAppDataAction?.chatDataAction.updateMessageAction?.message.cardsV2;

test("a button: the answer admitted once, its text answerText, from the clicker; the card says who answered what, the message's text and other cards kept", async () => {
  const s = await subject();
  const message = await s.drawn(confirm);
  const response = await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx);

  expect(s.dispatched).toEqual([
    { requestId: answerMessageId(CARD_MESSAGE, confirm.id), conversation: s.conversations.get(THREAD_KEY)!, prompt: answerText(confirm, { go: true }), sender: { channel: "googlechat", id: PERSON.name } },
  ]);
  expect(s.dispatched[0]?.prompt).toBe('Answer to "Deploy now?" (question c1:m1:call-1):\n- Deploy: yes');
  expect(response.hostAppDataAction?.chatDataAction.updateMessageAction?.message.text).toBe("Here is my question.");
  expect(updatedCards(response)).toEqual([message.cardsV2![0]!, answeredCard(confirm, { go: true }, "Ada Lovelace")]);
  expect(await s.questions.get(confirm.id)).toMatchObject({ answered: { by: PERSON.name, name: "Ada Lovelace", at: 1_000, text: answerText(confirm, { go: true }), answer: { go: true } } });
  // A thread's conversation says its thread: nothing to record.
  expect(s.remembered).toEqual([]);

  // Anyone after that is told, and nothing more is admitted.
  const again = await s.click(THREAD_KEY, press(confirm, message, "go", "false", GRACE), s.ctx);
  expect(again).toEqual({ action: { notification: { text: CLICK_NOTICES.answered } } });
  expect(s.dispatched).toHaveLength(1);
  // Delivery is woken after the answer admitted only.
  expect(s.handled).toEqual(["admitted", "done"]);
});

test("a reset closes the questions asked before it: a click once the key's conversation is another is told so, and admits nothing", async () => {
  const s = await subject();
  const message = await s.drawn(confirm);
  // `/new`: the key's conversation is not the one the question was asked in (s1) any more.
  s.conversations.set(THREAD_KEY, { key: THREAD_KEY, agent: "assistant", conversationId: "s2" });
  expect(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.reset } } });
  expect(s.dispatched).toEqual([]);
  expect((await s.questions.get(confirm.id))?.answered).toBeUndefined();
  expect(s.handled).toEqual(["done"]);

  // A key with no conversation at all counts as reset too.
  s.conversations.delete(THREAD_KEY);
  expect(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.reset } } });
  expect(s.dispatched).toEqual([]);

  // In the conversation it was asked in, it is answered.
  s.conversations.set(THREAD_KEY, { key: THREAD_KEY, agent: "assistant", conversationId: "s1" });
  expect(updatedCards(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx))).toBeDefined();
  expect(s.dispatched.map((request) => request.conversation.conversationId)).toEqual(["s1"]);
});

test("two clicks at once (or one Google repeats): one answer admitted, the other told it is answered", async () => {
  const s = await subject();
  const message = await s.drawn(select);
  const [one, two] = await Promise.all([s.click(THREAD_KEY, press(select, message, "env", "prod"), s.ctx), s.click(THREAD_KEY, press(select, message, "env", "staging", GRACE), s.ctx)]);
  const updatedOnes = [one, two].filter((response) => updatedCards(response!) !== undefined);
  expect(updatedOnes).toHaveLength(1);
  expect([one, two]).toContainEqual({ action: { notification: { text: CLICK_NOTICES.answered } } });
  // The runtime took one: the second was its duplicate.
  expect(s.dispatched.map((request) => request.requestId)).toEqual([answerMessageId(CARD_MESSAGE, select.id), answerMessageId(CARD_MESSAGE, select.id)]);
  expect(s.handled.toSorted()).toEqual(["admitted", "duplicate"]);
  expect((await s.questions.get(select.id))?.answered?.text).toBe(s.dispatched[0]?.prompt);
});

test("a button whose value is not one of the options is told why, and nothing is admitted", async () => {
  const s = await subject();
  const message = await s.drawn(select);
  const response = await s.click(THREAD_KEY, press(select, message, "env", "moon"), s.ctx);
  expect(response.action?.notification?.text).toBe('Your answer answers "Environment" with a value that is not one of its options.');
  expect(s.dispatched).toEqual([]);
  expect((await s.questions.get(select.id))?.answered).toBeUndefined();
});

test("a form: the dialog opens; sent with a problem it is drawn again with it; sent right it closes, the answer admitted and the card updated", async () => {
  const s = await subject();
  const message = await s.drawn(form, CHAT_KEY);
  const open = await s.click(CHAT_KEY, clickEvent({ message, parameters: { question: form.id, step: "open" }, dialogEventType: "REQUEST_DIALOG" }), s.ctx);
  expect(open).toEqual({ action: { navigations: [{ pushCard: questionDialog(form, ENDPOINT, CHAT_KEY) }] } });

  // A dialog's submit carries no message: the card's is read from Google, and only the question's card replaced.
  const submit = (formInputs: NonNullable<ClickEventOptions["formInputs"]>) =>
    s.click(CHAT_KEY, clickEvent({ parameters: { key: CHAT_KEY, question: form.id, step: "submit" }, formInputs, dialogEventType: "SUBMIT_DIALOG" }), s.ctx);
  const missing = await submit({ notes: textInput("ship it"), regions: textInput("us") });
  expect(missing).toEqual({
    action: {
      navigations: [{ updateCard: questionDialog(form, ENDPOINT, CHAT_KEY, { problem: 'Your answer does not answer "Day", which is required.', answer: { notes: "ship it", regions: ["us"] } }) }],
      notification: { text: 'Your answer does not answer "Day", which is required.' },
    },
  });
  expect(s.dispatched).toEqual([]);

  const answer = { notes: "ship it", regions: ["eu", "us"], day: "2026-03-01", notify: false, size: "s5" };
  const sent = await submit({ notes: textInput("ship it"), regions: textInput("eu", "us"), day: dateInput("2026-03-01"), notify: textInput("false"), size: textInput("s5") });
  expect(sent).toEqual({ action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }], notification: { text: "Answer sent." } } });
  expect(s.dispatched.map((request) => request.prompt)).toEqual([answerText(form, answer)]);
  expect(s.read).toEqual([CARD_MESSAGE]);
  expect(s.updated).toEqual([{ name: CARD_MESSAGE, message: { cardsV2: [message.cardsV2![0]!, answeredCard(form, answer, "Ada Lovelace")] }, fields: ["cardsV2"] }]);
  // A whole chat's answer goes to the card's thread.
  expect(s.remembered).toEqual([[answerKey(s.conversations.get(CHAT_KEY)!, answerMessageId(CARD_MESSAGE, form.id)), THREAD]]);

  // The dialog opened again on an answered question closes, saying so.
  const late = await s.click(CHAT_KEY, clickEvent({ message, parameters: { question: form.id, step: "open" }, dialogEventType: "REQUEST_DIALOG" }), s.ctx);
  expect(late).toEqual({ action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }], notification: { text: CLICK_NOTICES.answered } } });
});

test("a whole chat's answer: the card's thread read from Google when the click does not carry its message; none in a chat without threads", async () => {
  const s = await subject();
  await s.drawn(confirm, CHAT_KEY);
  await s.click(CHAT_KEY, press(confirm, undefined, "go", "true"), s.ctx);
  expect(s.read).toEqual([CARD_MESSAGE]);
  expect(s.remembered.map(([, thread]) => thread)).toEqual([THREAD]);

  const flat = await subject();
  await flat.drawn(confirm, CHAT_KEY);
  await flat.click(CHAT_KEY, clickEvent({ threading: "UNTHREADED_MESSAGES", parameters: { question: confirm.id, step: "answer", field: "go", value: "false" } }), flat.ctx);
  expect(flat.remembered.map(([, thread]) => thread)).toEqual([undefined]);
});

test("an unknown question, a click from a space not allowed, and a cancelled dialog admit nothing", async () => {
  const s = await subject();
  expect(await s.click(THREAD_KEY, press(confirm, undefined, "go", "true"), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.unknown } } });
  expect(await s.click(THREAD_KEY, clickEvent({ parameters: {} }), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.unknown } } });
  await s.drawn(confirm);
  expect(await s.click("googlechat:spaces/ZZZ:threads/T1", press(confirm, undefined, "go", "true"), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.stranger } } });
  expect(await s.click(THREAD_KEY, clickEvent({ dialogEventType: "CANCEL_DIALOG" }), s.ctx)).toEqual({ action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }] } });
  expect(s.dispatched).toEqual([]);
});

test("an answer the router denies is told why and leaves the question open", async () => {
  const s = await subject({ router: "deny" });
  const message = await s.drawn(confirm);
  expect(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx)).toEqual({ action: { notification: { text: `${CLICK_NOTICES.refused} Not today.` } } });
  expect((await s.questions.get(confirm.id))?.answered).toBeUndefined();
});

test("a capability failing rejects the click (Google shows an error) and leaves the question open: the next click is admitted", async () => {
  const s = await subject({ failures: 1 });
  const message = await s.drawn(confirm);
  await expect(s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx)).rejects.toThrow("storage down");
  expect((await s.questions.get(confirm.id))?.answered).toBeUndefined();
  expect(updatedCards(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx))).toBeDefined();
  expect(s.dispatched).toHaveLength(1);
});

test("a click is keyed by its action's key: a chat turned from threads into one conversation keeps an old card answerable in its thread's conversation", async () => {
  const s = await subject();
  const message = await s.drawn(confirm, THREAD_KEY);
  // The setting now says the whole chat is one conversation: a message there is keyed by the chat.
  const keyDeps = { instance: instancesOf([])[0]!, threading: createSpaceThreading({} as ChatApi, undefined), mode: async () => "chat" as const };
  const clicked = clickEvent({ message, parameters: { key: THREAD_KEY, question: confirm.id, step: "answer", field: "go", value: "true" } });
  const key = await eventKey(clicked, keyDeps, s.ctx);
  expect(key).toBe(THREAD_KEY);
  expect(updatedCards(await s.click(key!, clicked, s.ctx))).toBeDefined();
  expect(s.dispatched.map((request) => [request.conversation.key, request.conversation.conversationId])).toEqual([[THREAD_KEY, "s1"]]);
});

test("a forged key (another thread, another allowed space) is refused: nothing admitted, the card untouched", async () => {
  const s = await subject();
  const message = await s.drawn(confirm, THREAD_KEY);
  for (const forged of [`googlechat:${SPACE}:threads/T2`, `googlechat:${OTHER_SPACE}`]) {
    // The forged key's conversation exists and is the one the question's answer key names.
    s.conversations.set(forged, { key: forged, agent: "assistant", conversationId: "s1" });
    const response = await s.click(forged, press(confirm, message, "go", "true"), s.ctx);
    expect(response).toEqual({ action: { notification: { text: CLICK_NOTICES.unknown } } });
  }
  expect(s.dispatched).toEqual([]);
  expect(s.updated).toEqual([]);
  expect((await s.questions.get(confirm.id))?.answered).toBeUndefined();
  expect(s.handled).toEqual(["done", "done"]);
});

test("two questions on one message: each has its own answer id, and both are answered", async () => {
  const s = await subject();
  const message = await s.drawn([confirm, select]);
  expect(updatedCards(await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx))).toBeDefined();
  expect(updatedCards(await s.click(THREAD_KEY, press(select, message, "env", "prod"), s.ctx))).toBeDefined();
  expect(s.dispatched.map((request) => request.requestId)).toEqual([answerMessageId(CARD_MESSAGE, confirm.id), answerMessageId(CARD_MESSAGE, select.id)]);
  expect(s.handled).toEqual(["admitted", "admitted"]);
  expect((await s.questions.get(select.id))?.answered?.text).toBe(answerText(select, { env: "prod" }));
});

test("a duplicate with no claim (a stop between admission and marking): the click claims it and updates the card, so the question closes", async () => {
  const s = await subject();
  const message = await s.drawn(confirm);
  // The answer is in the runtime already; its claim was never written.
  s.seen.add(answerMessageId(CARD_MESSAGE, confirm.id));
  const response = await s.click(THREAD_KEY, press(confirm, message, "go", "true"), s.ctx);
  expect(updatedCards(response)).toEqual([message.cardsV2![0]!, answeredCard(confirm, { go: true }, "Ada Lovelace")]);
  expect(s.handled).toEqual(["duplicate"]);
  expect((await s.questions.get(confirm.id))?.answered).toMatchObject({ by: PERSON.name, answer: { go: true } });
  // The next click is told it is answered.
  expect(await s.click(THREAD_KEY, press(confirm, message, "go", "false"), s.ctx)).toEqual({ action: { notification: { text: CLICK_NOTICES.answered } } });
});

test("a whole chat's answer thread is recorded before dispatch: a failure admits nothing and rejects the click", async () => {
  const s = await subject({ rememberFails: true });
  const message = await s.drawn(confirm, CHAT_KEY);
  await expect(s.click(CHAT_KEY, press(confirm, message, "go", "true"), s.ctx)).rejects.toThrow("storage down");
  expect(s.dispatched).toEqual([]);
  expect((await s.questions.get(confirm.id))?.answered).toBeUndefined();
});

test("the records: answered once; sent again replaces nothing answered; an answer claimed before its record was written is read back", async () => {
  const store = createMemoryKeyValueStorage().namespace("channel-google-chat");
  const records: QuestionRecords = createQuestionRecords(store);
  expect(await records.get(confirm.id)).toBeUndefined();
  await records.sent({ question: confirm, message: CARD_MESSAGE, conversationKey: THREAD_KEY, answerKey: ASKED_IN });
  expect(await records.get(confirm.id)).toEqual({ question: confirm, message: CARD_MESSAGE, conversationKey: THREAD_KEY, answerKey: ASKED_IN });
  expect(await store.get(`question:${confirm.id}`)).toBeDefined();

  const answered = { by: PERSON.name, name: "Ada Lovelace", at: 5, text: "yes", answer: { go: true } };
  expect(await records.answer(confirm.id, answered)).toBe(true);
  expect(await records.answer(confirm.id, { ...answered, by: GRACE.name })).toBe(false);
  await records.sent({ question: confirm, message: `${SPACE}/messages/other`, conversationKey: THREAD_KEY, answerKey: ASKED_IN });
  expect(await records.get(confirm.id)).toEqual({ question: confirm, message: CARD_MESSAGE, conversationKey: THREAD_KEY, answerKey: ASKED_IN, answered });

  // A stop between the claim and the record's write: the claim still says it is answered.
  await store.set(`question:${select.id}`, { question: select, message: CARD_MESSAGE, conversationKey: THREAD_KEY, answerKey: ASKED_IN } as never);
  await store.set(`question:${select.id}:answered`, answered as never);
  expect((await records.get(select.id))?.answered).toEqual(answered);
});
