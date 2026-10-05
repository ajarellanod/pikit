/**
 * provider-faux's tests. They are copied with the component and keep running in your project. They
 * make no request anywhere.
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import { modelsFrom } from "@pikit/pi-adapter";
import providerFaux, { createFauxProvider, FAUX_MODEL, FAUX_PROVIDER, fauxAnswer, SCRIPTED_MODEL, scriptedReply } from "./index.ts";

type Messages = Parameters<typeof scriptedReply>[0];
const at = Date.now();
const user = (content: string) => ({ role: "user" as const, content, timestamp: at });
const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } }) as never;

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providerFaux], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "provider-faux", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-faux"], keys: { faux: "provider-faux" } });
});

test("faux/echo answers every turn with the newest user message, needing no credential, and never runs out", async () => {
  const models = modelsFrom([createFauxProvider()]);
  const model = models.getModel(FAUX_PROVIDER, FAUX_MODEL);
  if (model === undefined) throw new Error("no faux/echo");

  expect(await models.checkAuth(FAUX_PROVIDER, {})).toBeDefined();
  const answers: unknown[] = [];
  for (const text of ["hello", "again", "and again"]) {
    const answer = await models.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, {});
    answers.push(answer.content);
  }

  expect(answers).toEqual(["hello", "again", "and again"].map((text) => [{ type: "text", text: fauxAnswer(text) }]));
});

test("faux/scripted: `call: <tool> <json>` calls the tool, and the turn after its result answers with it", async () => {
  const models = modelsFrom([createFauxProvider()]);
  const model = models.getModel(FAUX_PROVIDER, SCRIPTED_MODEL);
  if (model === undefined) throw new Error("no faux/scripted");

  const called = await models.completeSimple(model, { messages: [user('call: remember {"fact":"Ana prefers tea"}')] }, {});
  expect(called.stopReason).toBe("toolUse");
  expect(called.content).toMatchObject([{ type: "toolCall", name: "remember", arguments: { fact: "Ana prefers tea" } }]);

  expect(scriptedReply([user("call: recall")])).toEqual({ call: "recall", arguments: {} });
  const result = (text: string, isError: boolean) => ({ role: "toolResult" as const, toolCallId: "c1", toolName: "remember", content: [{ type: "text" as const, text }], isError, timestamp: at });
  expect(scriptedReply([user("call: remember {}"), result("Remembered.", false)] as Messages)).toEqual({ text: "remember: Remembered." });
  expect(scriptedReply([user("call: remember {}"), result("secrets are never kept", true)] as Messages)).toEqual({ text: "remember failed: secrets are never kept" });
});

test("faux/scripted: arguments that are not a JSON object are answered, never called", () => {
  expect(scriptedReply([user("call: remember {fact}")])).toEqual({ text: "faux/scripted: the arguments of remember are not JSON: {fact}" });
  expect(scriptedReply([user("call: remember [1]")])).toEqual({ text: "faux/scripted: the arguments of remember are not a JSON object: [1]" });
});

test("faux/scripted: echo-system answers the system prompt as it stands, echo-tools the tools offered", () => {
  const system = (fields: Record<string, unknown>) => ({ role: "system" as const, content: "", timestamp: at, ...fields });
  const messages = [
    system({ content: "You are a helpful assistant.", sections: { rules: "<rules>\nBe brief.\n</rules>", memory: "<memory>\n- tea\n</memory>" }, toolsAdded: [tool("remember"), tool("bash")] }),
    user("hello"),
    system({ sections: { rules: null, memory: "<memory>\n- coffee\n</memory>" }, toolsRemoved: [{ name: "bash" }] }),
  ] as Messages;

  expect(scriptedReply([...messages, user("echo-system")])).toEqual({ text: "You are a helpful assistant.\n\n<memory>\n- coffee\n</memory>" });
  expect(scriptedReply([...messages, user("echo-system memory")])).toEqual({ text: "<memory>\n- coffee\n</memory>" });
  expect(scriptedReply([...messages, user("echo-system rules")])).toEqual({ text: "(no section rules)" });
  expect(scriptedReply([...messages, user("echo-tools")])).toEqual({ text: "remember" });
  expect(scriptedReply([user("echo-tools")])).toEqual({ text: "(no tools)" });
  expect(scriptedReply([...messages, user("anything else")])).toEqual({ text: fauxAnswer("anything else") });
});
