/**
 * The `question` part: its one check, its fallback, and an answer checked and said in words, as the
 * tool that asks and the channels that draw it share them.
 */

import { expect, test } from "bun:test";
import { foldParts, type MessagePart } from "./parts.ts";
import { answerProblem, answerText, type Question, questionFallback, questionPart, questionProblem } from "./question.ts";

const deploy: Question = {
  id: "c1:r1:t1",
  title: "Deploy now?",
  description: "The build passed.",
  fields: [
    { kind: "confirm", name: "go", label: "Deploy", required: true },
    { kind: "select", name: "env", label: "Environment", options: [{ value: "prod", label: "Production" }, { value: "staging", label: "staging" }], required: true },
    { kind: "multiselect", name: "notify", label: "Notify", options: [{ value: "ops", label: "Ops" }, { value: "dev", label: "Dev" }] },
    { kind: "text", name: "note", label: "Note" },
    { kind: "date", name: "when", label: "When" },
  ],
};

test("a question is checked: an id, a title, named fields of a known kind, options exactly where they apply", () => {
  expect(questionProblem(deploy)).toBeUndefined();
  expect(questionProblem(null)).toBe("is not an object");
  expect(questionProblem({ ...deploy, id: "" })).toMatch(/no id/);
  expect(questionProblem({ ...deploy, title: " " })).toMatch(/no title/);
  expect(questionProblem({ ...deploy, description: 3 })).toMatch(/description/);
  expect(questionProblem({ ...deploy, fields: [] })).toMatch(/no fields/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "slider", name: "a", label: "A" }] })).toMatch(/field 0 has no kind/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "text", name: "1a", label: "A" }] })).toMatch(/no name/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "text", name: "a", label: "A" }, { kind: "date", name: "a", label: "B" }] })).toMatch(/field 1 has the name "a"/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "text", name: "a", label: "" }] })).toMatch(/no label/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "text", name: "a", label: "A", required: "yes" }] })).toMatch(/required/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "select", name: "a", label: "A", options: [] }] })).toMatch(/no options/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "select", name: "a", label: "A", options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] }] })).toMatch(/"x" twice/);
  expect(questionProblem({ ...deploy, fields: [{ kind: "confirm", name: "a", label: "A", options: [{ value: "x", label: "X" }] }] })).toMatch(/has no options/);
});

test("a question's part carries its fallback: every field and what it takes, and how to answer", () => {
  const part = questionPart(deploy);
  expect(part.type).toBe("question");
  expect(part.id).toBe(deploy.id);
  expect(part.fallback).toBe(questionFallback(deploy));
  expect(part.fallback).toBe(
    [
      "**Deploy now?**",
      "",
      "The build passed.",
      "",
      "- Deploy: yes or no",
      "- Environment: one of Production (prod), staging",
      "- Notify (optional): any of Ops (ops), Dev (dev)",
      "- Note (optional): text",
      "- When (optional): a date (YYYY-MM-DD)",
      "",
      "Reply with your answer in a message.",
    ].join("\n"),
  );
  expect(() => questionPart({ ...deploy, fields: [] })).toThrow(TypeError);
});

test("a transport that does not draw questions sends the fallback; one that does keeps the part", () => {
  const part: MessagePart = questionPart(deploy);
  expect(foldParts({ text: "Before.", parts: [part] })).toEqual({ text: `Before.\n\n${part.fallback}`, parts: [] });
  expect(foldParts({ text: "", parts: [part] }, ["question"])).toEqual({ text: "", parts: [part] });
});

test("an answer is checked against its question", () => {
  const answer = { go: true, env: "prod", notify: ["ops"], note: "after lunch", when: "2025-01-31" };
  expect(answerProblem(deploy, answer)).toBeUndefined();
  expect(answerProblem(deploy, { env: "prod" })).toMatch(/"Deploy", which is required/);
  expect(answerProblem(deploy, { ...answer, env: " " })).toMatch(/"Environment", which is required/);
  expect(answerProblem(deploy, { ...answer, go: "yes" })).toMatch(/yes or no/);
  expect(answerProblem(deploy, { ...answer, env: "dev" })).toMatch(/not one of its options/);
  expect(answerProblem(deploy, { ...answer, notify: ["ops", "qa"] })).toMatch(/not among its options/);
  expect(answerProblem(deploy, { ...answer, note: ["x"] })).toMatch(/other than text/);
  expect(answerProblem(deploy, { ...answer, when: "31/01/2025" })).toMatch(/date/);
  expect(answerProblem(deploy, { ...answer, other: "x" })).toMatch(/"other", which the question does not ask/);
  expect(answerProblem(deploy, { go: false, env: "staging", notify: [], note: "" })).toBeUndefined();
});

test("an answer is said in words, with the question's id and each field's value", () => {
  expect(answerText(deploy, { go: true, env: "prod", notify: ["ops", "dev"], note: "after lunch", when: "2025-01-31" })).toBe(
    [
      'Answer to "Deploy now?" (question c1:r1:t1):',
      "- Deploy: yes",
      "- Environment: Production (prod)",
      "- Notify: Ops (ops), Dev (dev)",
      "- Note: after lunch",
      "- When: 2025-01-31",
    ].join("\n"),
  );
  expect(answerText(deploy, { go: false, env: "staging" })).toBe(
    ['Answer to "Deploy now?" (question c1:r1:t1):', "- Deploy: no", "- Environment: staging", "- Notify: no answer", "- Note: no answer", "- When: no answer"].join("\n"),
  );
});
