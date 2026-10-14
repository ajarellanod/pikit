/**
 * tool-ask-user: the agent tool `askUser`, for the agents that name it (`tools: ["askUser"]`). It asks
 * the person the agent talks to one question (a title, a description, fields: `confirm`, `select`,
 * `multiselect`, `text`, `date`) and ends the run (features/channel-google-chat.md "Questions").
 *
 * - **It never waits for the answer.** The question is a `question` part of the run's answer
 *   (`questionPart` from `@pikit/contracts`, given with `withParts`), and the run ends with it
 *   (`control.terminate`). A channel that draws it (Google Chat: buttons, a dialog) shows it; any other
 *   sends its fallback text. The answer comes back later as an ordinary message whose text says it
 *   ("Answer to …", `answerText`), the same whether a person clicked or typed it. A run that waited
 *   would hold its conversation (a Durable Object) awake for as long as the person takes.
 * - **Its id** is `<conversation id>:<request id>:<tool call id>`: the conversation (`CONVERSATION`),
 *   the request that started the run (`RUN_REQUESTS`, the first; outside a run the call's task id), and
 *   the call (`api.callId`). The answer's text names it, so the model knows which question it answers.
 * - **Its check** is `questionProblem`: a question it cannot ask is an error result the model reads.
 * - **Replay is `safe`**: asking again after a crash builds the same part, with the same id, and
 *   sends nothing itself (the answer's delivery does).
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { defineComponent } from "@pikit/core";
import { CONVERSATION, QUESTION_FIELD_KINDS, type Question, type QuestionField, questionPart, questionProblem, RUN_REQUESTS } from "@pikit/contracts";
import { defineTool, type ToolRegistration, withParts } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";

/** The name agents give it, and its key under `agent.tool`. */
export const ASK_USER_TOOL = "askUser";

const Option = Type.Object({
  value: Type.String({ minLength: 1, description: "What the answer carries." }),
  label: Type.String({ minLength: 1, description: "What the person reads." }),
});

const Field = Type.Object({
  kind: Type.Union(
    QUESTION_FIELD_KINDS.map((kind) => Type.Literal(kind)),
    { description: "confirm: yes or no. select: one of options. multiselect: any of options. text: free text. date: a day." },
  ),
  name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$", description: "The answer's key: a letter, then letters, digits, _ or -; unique in the question." }),
  label: Type.String({ minLength: 1, description: "What the person reads." }),
  required: Type.Optional(Type.Boolean({ description: "The answer must give it. Default: optional." })),
  options: Type.Optional(Type.Array(Option, { minItems: 1, description: "The choices, for select and multiselect only." })),
});

const Parameters = Type.Object({
  title: Type.String({ minLength: 1, description: "The question, short." }),
  description: Type.Optional(Type.String({ description: "What the person needs to know to answer." })),
  fields: Type.Array(Field, { minItems: 1, description: "What to answer: one confirm or select field is drawn as buttons." }),
});

export type AskUserArgs = Static<typeof Parameters>;

export const ASK_USER_DESCRIPTION = [
  "Asks the person you are talking to one question, with fields to answer (yes or no, a choice among options, several choices, text, a date), and ends your turn.",
  "Your turn ends with the question: do not wait for the answer, and write nothing after the call. Their answer arrives later as a new message that starts with 'Answer to' and names the question.",
  "Ask only what you cannot decide yourself. One confirm or select field is answered with a button; anything else with a form.",
].join("\n");

/** The question `args` ask, with the id of this call. */
export function questionOf(args: AskUserArgs, id: string): Question {
  const fields = args.fields.map(
    (field) =>
      ({
        kind: field.kind,
        name: field.name,
        label: field.label,
        ...(field.required !== undefined && { required: field.required }),
        ...(field.options !== undefined && { options: field.options.map((option) => ({ value: option.value, label: option.label })) }),
      }) as QuestionField,
  );
  return { id, title: args.title, ...(args.description !== undefined && args.description.trim() !== "" && { description: args.description }), fields };
}

/** The `askUser` tool. */
export function createAskUserTool(): ToolRegistration {
  return defineTool({
    name: ASK_USER_TOOL,
    description: ASK_USER_DESCRIPTION,
    parameters: Parameters,
    replay: "safe",
    async execute(args, api, context) {
      const conversationId = context.value(CONVERSATION)?.conversationId ?? String(api.conversationId);
      const requests = await context.value(RUN_REQUESTS)?.list(context);
      const requestId = requests?.[0]?.requestId ?? String(api.taskId);
      const question = questionOf(args, `${conversationId}:${requestId}:${api.callId}`);
      const problem = questionProblem(question);
      if (problem !== undefined) throw new Error(`the question cannot be asked: it ${problem}`);
      const output = `Asked "${question.title}" (question ${question.id}). Your turn ends here: the answer will arrive as a new message.`;
      return withParts({ output: [{ type: "text", text: output }], control: { terminate: true } }, [questionPart(question)]);
    },
  }) as unknown as ToolRegistration;
}

export default defineComponent({
  name: "tool-ask-user",
  setup(pikit) {
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", ASK_USER_TOOL, createAskUserTool());
  },
});
