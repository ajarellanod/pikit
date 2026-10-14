/**
 * tool-ask-user's tests. They are copied with the component and keep running in your project.
 *
 * From the inside out: the tool called directly (`callTool`), in a conversation's run (`CONVERSATION`,
 * `RUN_REQUESTS` in its context, as the runtime gives them) or outside one; the tool as the component
 * installs it; and a real Harness turn (`runToolCalls`), where the call ends the run. The run's
 * `AgentResult.parts` through runtime-pi is `app.test.ts` beside `files/` in the registry.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, silentLogger, withContextValue } from "@pikit/core";
import { answerProblem, answerText, CONVERSATION, QUESTION_FIELD_NAME, type QuestionPart, questionPart, questionProblem, RUN_REQUESTS } from "@pikit/contracts";
import { callTool, runToolCalls } from "@pikit/pi-adapter/execution/testing";
import { PARTS_DETAIL } from "@pikit/pi-adapter/tools";
import toolAskUser, { ASK_USER_TOOL, createAskUserTool } from "./index.ts";

const inRun = withContextValue(
  RUN_REQUESTS,
  { list: async () => [{ requestId: "spaces/AAA/messages/m1" }, { requestId: "spaces/AAA/messages/m2" }] },
  withContextValue(CONVERSATION, { key: "googlechat:spaces/AAA", agent: "assistant", conversationId: "c7" }, BACKGROUND_CONTEXT),
);

const deploy = {
  title: "Deploy now?",
  description: "The build passed.",
  fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }],
};

const partsOf = (details: unknown): QuestionPart[] => ((details as Record<string, unknown> | undefined)?.[PARTS_DETAIL] ?? []) as QuestionPart[];

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [toolAskUser], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "tool-ask-user")).toMatchObject({ provides: ["agent.tool"], requires: [], optional: [] });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ [ASK_USER_TOOL]: "tool-ask-user" });
});

test("its name, its description, and its replay: safe", () => {
  const tool = createAskUserTool();
  expect(tool.name).toBe(ASK_USER_TOOL);
  expect(tool.replay).toBe("safe");
  expect(tool.description).toContain("ends your turn");
});

test("what the model is told is the outcome, channel-neutral: never how a channel draws a question or words its answer", () => {
  const tool = createAskUserTool();
  expect(tool.description).toContain("The person may answer with a form or in their own words; their answer arrives later as a new message.");
  // The description and every parameter's: no drawer (buttons, cards, a dialog, a platform), no answer's wording.
  const told = JSON.stringify([tool.description, tool.parameters]);
  for (const drawer of [/button/i, /card/i, /dialog/i, /google/i, /Answer to/]) expect(told).not.toMatch(drawer);
});

test("a field's name is the contracts' pattern (QUESTION_FIELD_NAME), the one questionProblem checks", () => {
  const name = (tool: ReturnType<typeof createAskUserTool>) =>
    (tool.parameters as unknown as { properties: { fields: { items: { properties: { name: { pattern: string } } } } } }).properties.fields.items.properties.name.pattern;
  expect(name(createAskUserTool())).toBe(QUESTION_FIELD_NAME);
  const asked = (field: string) => questionProblem({ id: "q", title: "T", fields: [{ kind: "text", name: field, label: "L" }] });
  expect(asked("go_2-b")).toBeUndefined();
  expect(asked("2go")).toContain("has no name");
});

test("a call gives the question as a part, its id the conversation, the run's first request and the call, and ends the run", async () => {
  const tool = createAskUserTool();
  const outcome = await callTool(tool, deploy, { context: inRun });
  expect(outcome.isError).toBe(false);
  const [part, ...more] = partsOf(outcome.details);
  expect(more).toEqual([]);
  expect(part).toEqual({
    type: "question",
    id: "c7:spaces/AAA/messages/m1:call-1",
    title: "Deploy now?",
    description: "The build passed.",
    fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }],
    fallback: questionPart({ id: "c7:spaces/AAA/messages/m1:call-1", ...deploy } as never).fallback,
  });
  expect(outcome.text).toBe('Asked "Deploy now?" (question c7:spaces/AAA/messages/m1:call-1). Your turn ends here: the answer will arrive as a new message.');
  // Its answer, said in words, names the question.
  expect(answerProblem(part!, { go: true })).toBeUndefined();
  expect(answerText(part!, { go: true })).toBe('Answer to "Deploy now?" (question c7:spaces/AAA/messages/m1:call-1):\n- Deploy: yes');

  const result = await tool.execute(deploy as never, { taskId: "t1", conversationId: "c7", callId: "call-1" } as never, inRun as never);
  expect(result.control).toEqual({ terminate: true });
});

test("outside a run, the id is pi-durable's conversation and the call's task; an empty description is left out", async () => {
  const outcome = await callTool(createAskUserTool(), { ...deploy, description: "  " });
  const [part] = partsOf(outcome.details);
  expect(part?.id).toBe("conversation-1:task-1:call-1");
  expect(part).not.toHaveProperty("description");
});

test("a question it cannot ask is an error the model reads, and no part", async () => {
  const tool = createAskUserTool();
  const select = { title: "Pick", fields: [{ kind: "select", name: "env", label: "Environment" }] };
  const twice = { title: "Pick", fields: [{ kind: "text", name: "a", label: "A" }, { kind: "date", name: "a", label: "B" }] };
  const optionsOnText = { title: "Pick", fields: [{ kind: "text", name: "a", label: "A", options: [{ value: "x", label: "X" }] }] };
  for (const [args, message] of [
    [select, '"env" has no options'],
    [twice, 'has the name "a" of another field'],
    [optionsOnText, "is text, which has no options"],
  ] as const) {
    const outcome = await callTool(tool, args, { context: inRun });
    expect(outcome.isError).toBe(true);
    expect(outcome.diagnostics.map((each) => each.message).join("")).toContain(message);
    expect(partsOf(outcome.details)).toEqual([]);
  }
});

test("in a Harness turn: the call ends the run, so a call after it is never made; a malformed question is refused before it runs", async () => {
  const tool = createAskUserTool();
  const asked = await runToolCalls({
    tools: [tool],
    calls: [
      { name: ASK_USER_TOOL, args: { title: "Which?", fields: [{ kind: "select", name: "env", label: "Env", options: [{ value: "prod", label: "Production" }] }] } },
      { name: ASK_USER_TOOL, args: deploy },
    ],
  });
  expect(asked).toEqual([{ name: ASK_USER_TOOL, text: expect.stringMatching(/^Asked "Which\?" \(question .+:call-1\)/) as never, isError: false }]);

  const refused = await runToolCalls({ tools: [tool], calls: [{ name: ASK_USER_TOOL, args: { title: "Which?", fields: [] } }] });
  expect(refused.map((each) => each.isError)).toEqual([true]);
});
