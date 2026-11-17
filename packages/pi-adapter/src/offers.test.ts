/**
 * `offerTools` in the runtime (agent.ts, runtime.ts): what the conversation's record keeps, an answer
 * that never comes (`offerTimeoutMs`), names that are not the extension's, and a name two extensions
 * provide. runtime-pi's `offer-tools.test.ts` takes it through a real App (refusal by name, per
 * conversation, restart, failures).
 */

import { afterEach, expect, test } from "bun:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationRef } from "@pikit/contracts";
import { Type } from "typebox";
import { ConversationDoc, type DurableExtension, offerOf, offerTools } from "./agent.ts";
import { toChord } from "./context.ts";
import { databaseFile, type ModelRequest, openWorker, scriptedProvider } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }) });

function offered(request: ModelRequest | undefined): string[] {
  const tools: string[] = [];
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const each of message.toolsRemoved ?? []) tools.splice(tools.indexOf(each.name), 1);
    for (const each of message.toolsAdded ?? []) tools.push(each.name);
  }
  return tools.sort();
}

async function worker(extensions: DurableExtension[], offerTimeoutMs?: number) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const requests: ModelRequest[] = [];
  const w = await openWorker(file.path, {
    agents: [{ name: "scripted", model: "faux/scripted", extensions: extensions.map((each) => each.name) }],
    providers: [scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })],
    runtime: { extension: (name) => extensions.find((each) => each.name === name), ...(offerTimeoutMs !== undefined && { offerTimeoutMs }) },
  });
  cleanup.push(w.close);
  const ask = async (conversation: ConversationRef, requestId: string, prompt = "hello") => {
    await w.dispatch(requestId, prompt, conversation);
    return w.result(requestId);
  };
  const recorded = async (conversation: ConversationRef) => {
    const { harness } = await w.runtime.opened(w.ctx);
    return harness.snapshot(ConversationDoc, Number(conversation.conversationId) as never, toChord(w.ctx));
  };
  return { ...w, requests, ask, recorded };
}

test("offerTools gives a copy carrying the choice, and refuses what is no function", () => {
  const plain = defineExtension({ name: "plain", tools: [tool("a")] });
  const choice = async () => ["a"];

  const declared = offerTools(plain, choice);

  expect([declared.name, declared.tools?.map((each) => each.name), offerOf(declared) === choice, offerOf(plain)]).toEqual(["plain", ["a"], true, undefined]);
  // A spread copy (an extension wrapped by its provider) keeps it.
  expect(offerOf({ ...declared }) === choice).toBe(true);
  expect(() => offerTools(plain, "a" as never)).toThrow('offerTools("plain"): offered must be a function');
});

test("the answer is kept sorted in the conversation's record; names that are not the extension's are ignored; undefined offers all", async () => {
  let answer: string[] | undefined = ["b", "nope", "b"];
  const family = offerTools(defineExtension({ name: "family", tools: [tool("a"), tool("b")] }), async () => answer);
  const w = await worker([family]);
  const conversation = await w.conversation();

  await w.ask(conversation, "r1");
  const first = await w.recorded(conversation);
  answer = undefined;
  await w.ask(conversation, "r2");

  expect(first?.offered).toEqual({ family: ["b", "nope"] });
  expect((await w.recorded(conversation))?.offered).toEqual({ family: null });
  expect(w.requests.map(offered)).toEqual([["b"], ["a", "b"]]);
});

test("an answer that never comes counts as a failure after offerTimeoutMs: none of the extension's tools, and the message is answered", async () => {
  const silent = offerTools(defineExtension({ name: "silent", tools: [tool("a")] }), () => new Promise<never>(() => {}));
  const other = defineExtension({ name: "other", tools: [tool("b")] });
  const w = await worker([silent, other], 50);
  const conversation = await w.conversation();

  const result = await w.ask(conversation, "r1");

  expect(result.kind).toBe("completed");
  expect(offered(w.requests[0])).toEqual(["b"]);
  expect((await w.recorded(conversation))?.offered).toEqual({ silent: [] });
});

test("a name two extensions provide follows the one whose tool wins it (the later): its choice decides", async () => {
  const first = defineExtension({ name: "first", tools: [tool("shared"), tool("mine")] });
  const later = offerTools(defineExtension({ name: "later", tools: [tool("shared"), tool("kept")] }), async () => ["kept"]);
  const w = await worker([first, later]);

  await w.ask(await w.conversation(), "r1");

  expect(offered(w.requests[0])).toEqual(["kept", "mine"]);
});

test("without an extension declaring a choice, the record has no offers", async () => {
  const w = await worker([defineExtension({ name: "other", tools: [tool("b")] })]);
  const conversation = await w.conversation();

  await w.ask(conversation, "r1");

  expect((await w.recorded(conversation))?.offered).toBeUndefined();
  expect(offered(w.requests[0])).toEqual(["b"]);
});
