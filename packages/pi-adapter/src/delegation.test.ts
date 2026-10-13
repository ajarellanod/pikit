/**
 * Delegation in the durable runtime (`delegation.ts`), on pi-durable's subagents: a tool's child
 * conversation runs as another agent, is owned by the call (`run`) or outlives it (`start`), resumes
 * after a crash, and a background task's answer reaches the parent through `dispatch` (logged,
 * announced). The scripted model: `call: <tool> <json>` calls a tool, `hold` calls `hold`, anything
 * else is answered `answer: <message>`.
 */

import { afterEach, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { CONVERSATION, defineAgent, RUN_REQUESTS, type RunRequest } from "@pikit/contracts";
import type { DurableTool } from "./agent.ts";
import { ConversationDoc } from "./agent.ts";
import { toChord } from "./context.ts";
import { AGENT_DELEGATION, RESULT_REQUEST_PREFIX } from "./delegation.ts";
import { databaseFile, holdTool, openWorker, type WorkerOptions } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The test's delegate tool: `run` or `start` on the runtime's delegation, as a tool component would. */
const delegate = defineTool({
  name: "delegate",
  description: "Delegates",
  parameters: Type.Object({ agent: Type.String(), task: Type.String(), wait: Type.Optional(Type.Boolean()) }),
  replay: "safe",
  async execute(args, api, context) {
    const delegation = context.value(AGENT_DELEGATION);
    const parent = context.value(CONVERSATION);
    if (delegation === undefined || parent === undefined) throw new Error("no delegation in the context");
    const task = { agent: args.agent, key: `delegate:1:${String(api.taskId)}`, channel: "delegate", task: args.task, sender: { channel: "delegate", id: parent.agent } };
    if (args.wait === false) {
      await delegation.start(api, task, context);
      return { output: [{ type: "text", text: "started" }] };
    }
    const outcome = await delegation.run(api, task, context);
    return { output: [{ type: "text", text: JSON.stringify(outcome) }] };
  },
}) as unknown as DurableTool;

/** A hold for the helper: blocks until released or its run stops; records what its run's requests and conversation are. */
function hold() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const seen: { requests?: readonly RunRequest[] | undefined; key?: string | undefined; agent?: string | undefined; channel?: string | undefined; aborted: boolean } = { aborted: false };
  const tool = holdTool(async (context) => {
    seen.requests = await context.value(RUN_REQUESTS)?.list(context);
    seen.key = context.value(CONVERSATION)?.key;
    seen.agent = context.value(CONVERSATION)?.agent;
    seen.channel = context.value(CONVERSATION)?.channel;
    started();
    await new Promise<void>((resolve, reject) => {
      const signal = context.abortSignal;
      const stop = () => {
        seen.aborted = true;
        reject(signal?.reason);
      };
      if (signal?.aborted) return stop();
      signal?.addEventListener("abort", stop, { once: true });
      void released.then(resolve);
    });
    return "released";
  });
  return { tool, started: holding, release: () => release(), seen };
}

const agents = [
  defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate"] }),
  defineAgent({ name: "helper", model: "faux/scripted", systemPrompt: "You help.", tools: ["hold"] }),
];

function records() {
  const file = databaseFile();
  cleanup.push(file.dispose);
  return {
    async worker(options: WorkerOptions) {
      const w = await openWorker(file.path, { agents, ...options });
      cleanup.push(w.close);
      return w;
    },
  };
}

/** The text of the tool results in `messages`. */
const toolResults = (messages: readonly unknown[]): string[] =>
  (messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

test("run: the task runs in a child conversation of the other agent, its sender the delegating agent, and the call gets its answer", async () => {
  const held = hold();
  held.release();
  const w = await (await records()).worker({ tools: { delegate, hold: held.tool } });
  const conversation = await w.conversation("assistant");

  await w.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold"}', conversation);
  const result = await w.result("r1");

  expect(result.kind).toBe("completed");
  expect(toolResults(result.messages)).toEqual([JSON.stringify({ kind: "completed", text: "answer: hold" })]);
  expect(held.seen.agent).toBe("helper");
  expect(held.seen.key).toStartWith("delegate:1:");
  // The child conversation's channel is the one the tool gave the task.
  expect(held.seen.channel).toBe("delegate");
  expect(held.seen.requests).toEqual([{ requestId: expect.stringMatching(/^delegate:/) as never, sender: { channel: "delegate", id: "assistant" } }]);
  // The child's run is not the parent's: no result of its own is announced or logged.
  expect(w.results().map((each) => each.requestId)).toEqual(["r1"]);
});

test("run: a call made again after a crash finds the child it created and its input, and waits again", async () => {
  const db = await records();
  const first = hold();
  const w1 = await db.worker({ tools: { delegate, hold: first.tool } });
  const conversation = await w1.conversation("assistant");
  await w1.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold"}', conversation);
  await first.started;
  await w1.close();

  const next = hold();
  next.release();
  const w2 = await db.worker({ tools: { delegate, hold: next.tool } });
  await w2.runtime.resume(conversation, w2.ctx);
  const result = await w2.result("r1");

  expect(result.kind).toBe("completed");
  // The child's hold was cut by the crash (not replayed: the model reads it was interrupted); it answered once.
  expect(toolResults(result.messages)).toEqual([JSON.stringify({ kind: "completed", text: "answer: hold" })]);
  const { storage } = await w2.runtime.opened(w2.ctx);
  const children = await storage.scanConversations({}, 100, undefined, toChord(w2.ctx));
  expect(children.items.length).toBe(2);
});

test("run: stopping the parent's run stops the child it waits for", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, hold: held.tool } });
  const conversation = await w.conversation("assistant");
  await w.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold"}', conversation);
  await held.started;

  await w.runtime.abort(conversation, w.ctx);

  expect((await w.result("r1")).kind).toBe("aborted");
  expect(held.seen.aborted).toBe(true);
});

test("run: an agent the App does not have is an error the model reads", async () => {
  const w = await (await records()).worker({ tools: { delegate, hold: hold().tool } });
  await w.dispatch("r1", 'call: delegate {"agent":"nobody","task":"x"}', await w.conversation("assistant"));
  const result = await w.result("r1");

  expect(JSON.stringify(result.messages)).toContain('there is no agent \\"nobody\\" in this project');
});

test("start: the call returns at once; the task's answer reaches the parent later as a message of its own, logged and announced", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, hold: held.tool } });
  const conversation = await w.conversation("assistant");

  await w.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold","wait":false}', conversation);
  expect(toolResults((await w.result("r1")).messages)).toEqual(["started"]);
  await held.started;
  held.release();

  const reported = await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));
  expect(reported.kind).toBe("completed");
  expect(reported.conversation.conversationId).toBe(conversation.conversationId);
  expect(reported.text).toContain('[The agent "helper" finished the task you delegated to it.');
  expect(reported.text).toContain("answer: hold");
  // In the answers feed, as any run of the parent: its channel delivers it.
  const answers = await w.runtime.submissions.answers.read(undefined, 10);
  expect(answers.items.map((item) => item.fact.requestId)).toContain(reported.requestId);
});

test("start: a background task outlives a restart, and still reports to its parent", async () => {
  const db = await records();
  const first = hold();
  const w1 = await db.worker({ tools: { delegate, hold: first.tool } });
  const conversation = await w1.conversation("assistant");
  await w1.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold","wait":false}', conversation);
  await w1.result("r1");
  await first.started;
  await w1.close();

  const w2 = await db.worker({ tools: { delegate, hold: hold().tool } });
  // Opening pi-durable resumes the background tasks.
  await w2.runtime.inspect(w2.ctx);
  const reported = await w2.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

  expect(reported.conversation.conversationId).toBe(conversation.conversationId);
  expect(reported.text).toContain("finished the task you delegated");
});

test("the child records its key and agent, so a reopened runtime builds it as the other agent", async () => {
  const held = hold();
  held.release();
  const w = await (await records()).worker({ tools: { delegate, hold: held.tool } });
  await w.dispatch("r1", 'call: delegate {"agent":"helper","task":"hold"}', await w.conversation("assistant"));
  await w.result("r1");

  const { harness, storage } = await w.runtime.opened(w.ctx);
  const all = (await storage.scanConversations({}, 100, undefined, toChord(w.ctx))).items;
  const docs = await Promise.all(all.map((each) => harness.snapshot(ConversationDoc, each.id as ConversationId, toChord(w.ctx))));
  expect(docs.map((doc) => doc?.agent).sort()).toEqual(["assistant", "helper"]);
});
