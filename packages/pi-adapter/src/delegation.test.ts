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
import { CONVERSATION, type ConversationOrigin, type ConversationRef, defineAgent, type MessagePart, originOf, RUN_REQUESTS, type RunRequest } from "@pikit/contracts";
import type { DurableTool } from "./agent.ts";
import { ConversationDoc } from "./agent.ts";
import { toChord } from "./context.ts";
import { AGENT_DELEGATION, type BackgroundDelegation, RESULT_LIMIT, RESULT_REQUEST_PREFIX } from "./delegation.ts";
import { withParts } from "./parts.ts";
import { databaseFile, holdTool, openWorker, type Worker, type WorkerOptions } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * The test's delegate tool: `run` or `start` on the runtime's delegation, as a tool component would;
 * `start` answers `started <id>` (`twice`: started again in the same call, as a rerun would, and both ids).
 */
const delegate = defineTool({
  name: "delegate",
  description: "Delegates",
  parameters: Type.Object({ agent: Type.String(), task: Type.String(), wait: Type.Optional(Type.Boolean()), twice: Type.Optional(Type.Boolean()) }),
  replay: "safe",
  async execute(args, api, context) {
    const delegation = context.value(AGENT_DELEGATION);
    const parent = context.value(CONVERSATION);
    if (delegation === undefined || parent === undefined) throw new Error("no delegation in the context");
    const task = { agent: args.agent, key: `delegate:1:${String(api.taskId)}`, channel: "delegate", task: args.task, sender: { channel: "delegate", id: parent.agent } };
    if (args.wait === false) {
      const ids = [await delegation.start(api, task, context)];
      if (args.twice === true) ids.push(await delegation.start(api, task, context));
      return { output: [{ type: "text", text: `started ${ids.join(" ")}` }] };
    }
    const outcome = await delegation.run(api, task, context);
    return { output: [{ type: "text", text: JSON.stringify(outcome) }] };
  },
}) as unknown as DurableTool;

/** The test's control tool: `list`, `steer` or `cancel` on the runtime's delegation; answers with the result as JSON. */
const control = defineTool({
  name: "control",
  description: "Controls background tasks",
  parameters: Type.Object({ op: Type.String(), id: Type.Optional(Type.String()), message: Type.Optional(Type.String()) }),
  replay: "safe",
  async execute(args, api, context) {
    const delegation = context.value(AGENT_DELEGATION);
    if (delegation === undefined) throw new Error("no delegation in the context");
    const result =
      args.op === "list"
        ? await delegation.list(api, context)
        : args.op === "steer"
          ? await delegation.steer(api, args.id ?? "", args.message ?? "", context)
          : await delegation.cancel(api, args.id ?? "", context);
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  },
}) as unknown as DurableTool;

/** A hold for the helper: blocks until released or its run stops; records what its run's requests and conversation are. */
function hold(replay: "safe" | "unsafe" = "unsafe") {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const seen: {
    requests?: readonly RunRequest[] | undefined;
    key?: string | undefined;
    agent?: string | undefined;
    channel?: string | undefined;
    origin?: ConversationOrigin | undefined;
    aborted: boolean;
  } = { aborted: false };
  const tool = holdTool(async (context) => {
    seen.requests = await context.value(RUN_REQUESTS)?.list(context);
    seen.key = context.value(CONVERSATION)?.key;
    seen.agent = context.value(CONVERSATION)?.agent;
    seen.channel = context.value(CONVERSATION)?.channel;
    seen.origin = context.value(CONVERSATION)?.origin;
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
  }, replay);
  return { tool, started: holding, release: () => release(), seen };
}

/** A question for the person, as a tool of the helper's asks it. */
const QUESTION = { type: "question", fallback: "Pay acme 10? Answer yes or no." } as unknown as MessagePart;

/** The helper's `ask`: ends its run with `QUESTION` as a part, as askUser and request_approval do. */
const ask = defineTool({
  name: "ask",
  description: "Asks the person",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => withParts({ output: [{ type: "text", text: "Asked." }], control: { terminate: true } }, [QUESTION]),
}) as unknown as DurableTool;

/** What the relay's `prepare` was given as its conversation, each time. */
const prepared: ConversationRef[] = [];

const agents = [
  defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate", "control"] }),
  defineAgent({ name: "helper", model: "faux/scripted", systemPrompt: "You help.", tools: ["hold", "ask"] }),
  // Delegates again: a task two delegations deep.
  defineAgent({
    name: "relay",
    model: "faux/scripted",
    tools: ["delegate"],
    prepare: (_state, ctx) => {
      prepared.push(ctx.conversation);
      return {};
    },
  }),
];

function records() {
  const file = databaseFile();
  cleanup.push(file.dispose);
  return {
    async worker(options: WorkerOptions) {
      const w = await openWorker(file.path, { agents, ...options, tools: { control, ask, ...options.tools } });
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
  expect(toolResults((await w.result("r1")).messages)).toEqual([expect.stringMatching(/^started \d+$/) as never]);
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

/** Starts `task` for the helper in the background from `conversation` (run `requestId`), and returns its id. */
async function startTask(w: Worker, conversation: ConversationRef, requestId: string, task = "hold", twice = false): Promise<string> {
  await w.dispatch(requestId, `call: delegate ${JSON.stringify({ agent: "helper", task, wait: false, ...(twice && { twice }) })}`, conversation);
  const [text] = toolResults((await w.result(requestId)).messages);
  return text?.replace(/^started /, "") ?? "";
}

/** Calls `control` from `conversation` (run `requestId`), and returns what it answered. */
async function controlCall(w: Worker, conversation: ConversationRef, requestId: string, args: { op: string; id?: string; message?: string }): Promise<unknown> {
  await w.dispatch(requestId, `call: control ${JSON.stringify(args)}`, conversation);
  return JSON.parse(toolResults((await w.result(requestId)).messages)[0] ?? "null");
}

/** The background results reported so far. */
const reports = (w: Worker) => w.results().filter((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

/** A `hold` that ends its run (`terminate`), so a steer queued meanwhile is placed after the run's answer, in a run of its own. */
function terminatingHold() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const tool = defineTool({
    name: "hold",
    description: "Blocks until the test releases it, then ends the run.",
    parameters: Type.Object({}),
    async execute() {
      started();
      await released;
      return { output: [{ type: "text", text: "released" }], control: { terminate: true } };
    },
  }) as unknown as DurableTool;
  return { tool, started: holding, release: () => release() };
}

test("start: its id is the call's task id, the same when the call starts it again; one child, one report", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool } });
  const conversation = await w.conversation("assistant");

  const ids = (await startTask(w, conversation, "r1", "hold", true)).split(" ");
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0] as string);
  const { storage } = await w.runtime.opened(w.ctx);
  expect((await storage.scanConversations({}, 100, undefined, toChord(w.ctx))).items.length).toBe(2);

  held.release();
  await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));
  await w.dispatch("r2", "after", conversation);
  await w.result("r2");
  expect(reports(w)).toHaveLength(1);
});

test("list: this conversation's background tasks, running and then how they ended (bounded), after a restart; foreground ones are not listed", async () => {
  const db = await records();
  const first = hold();
  const w1 = await db.worker({ tools: { delegate, control, hold: first.tool } });
  const conversation = await w1.conversation("assistant");
  const id = await startTask(w1, conversation, "r1");
  await first.started;
  expect(await controlCall(w1, conversation, "r2", { op: "list" })).toEqual([{ id, agent: "helper", status: "running" }]);
  await w1.close();

  const next = hold();
  next.release();
  const w2 = await db.worker({ tools: { delegate, control, hold: next.tool } });
  await w2.runtime.inspect(w2.ctx);
  await w2.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));
  // A foreground delegation is the call's: not listed.
  await w2.dispatch("r3", 'call: delegate {"agent":"helper","task":"x"}', conversation);
  await w2.result("r3");
  const long = await startTask(w2, conversation, "r4", "y".repeat(RESULT_LIMIT + 100));
  await w2.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX) && each.text?.includes("yyy") === true);

  const listed = (await controlCall(w2, conversation, "r5", { op: "list" })) as BackgroundDelegation[];
  expect(listed[0]).toEqual({ id, agent: "helper", status: "completed", result: "answer: hold" });
  expect(listed.map((each) => each.id)).toEqual([id, long]);
  expect(listed[1]?.result).toBe(`${`answer: ${"y".repeat(RESULT_LIMIT + 100)}`.slice(0, RESULT_LIMIT)} [...]`);
});

test("steer: reaches the child's run in progress, from the delegating agent; the one report answers it; a task that ended takes none", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool } });
  const conversation = await w.conversation("assistant");
  const id = await startTask(w, conversation, "r1");
  await held.started;

  expect(await controlCall(w, conversation, "r2", { op: "steer", id, message: "hold" })).toBe("running");
  held.release();
  const reported = await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

  // The steer joined the run: its second hold saw both requests, each from the delegating agent.
  const sender = { channel: "delegate", id: "assistant" };
  expect(held.seen.requests).toEqual([
    { requestId: `delegate:${id}`, sender },
    { requestId: expect.stringMatching(/^delegate-steer:/) as never, sender },
  ]);
  expect(reported.text).toContain("answer: hold");
  expect(await controlCall(w, conversation, "r3", { op: "steer", id, message: "more" })).toBe("completed");
  expect(await controlCall(w, conversation, "r4", { op: "cancel", id })).toBe("completed");
  expect(await controlCall(w, conversation, "r5", { op: "steer", id: "999", message: "more" })).toBe("not_found");
  expect(reports(w)).toHaveLength(1);
});

test("steer: one that comes after the child's last tool round runs after it, and the report is its answer, not the run before", async () => {
  const held = terminatingHold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool } });
  const conversation = await w.conversation("assistant");
  const id = await startTask(w, conversation, "r1");
  await held.started;

  expect(await controlCall(w, conversation, "r2", { op: "steer", id, message: "and then this" })).toBe("running");
  // The hold ends the run: the steer cannot join it, and starts a run of its own.
  held.release();
  const reported = await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

  expect(reported.text).toContain("answer: and then this");
  expect(await controlCall(w, conversation, "r3", { op: "list" })).toEqual([{ id, agent: "helper", status: "completed", result: "answer: and then this" }]);
});

test("cancel: stops the child, and the parent hears it was stopped once; cancelling again does nothing more", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool } });
  const conversation = await w.conversation("assistant");
  const id = await startTask(w, conversation, "r1");
  await held.started;

  expect(await controlCall(w, conversation, "r2", { op: "cancel", id })).toBe("aborted");
  expect(held.seen.aborted).toBe(true);
  const reported = await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));
  expect(reported.text).toContain('[The task you delegated to the agent "helper" was stopped before it answered.]');

  expect(await controlCall(w, conversation, "r3", { op: "cancel", id })).toBe("aborted");
  expect(await controlCall(w, conversation, "r4", { op: "steer", id, message: "hold" })).toBe("aborted");
  expect(await controlCall(w, conversation, "r5", { op: "list" })).toEqual([{ id, agent: "helper", status: "aborted" }]);
  expect(reports(w)).toHaveLength(1);
});

test("another conversation's task is not_found: it lists none, and can neither steer nor cancel it", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool } });
  const mine = await w.conversation("assistant");
  const other = await w.conversation("assistant");
  const id = await startTask(w, mine, "r1");
  await held.started;

  expect(await controlCall(w, other, "o1", { op: "list" })).toEqual([]);
  expect(await controlCall(w, other, "o2", { op: "steer", id, message: "hold" })).toBe("not_found");
  expect(await controlCall(w, other, "o3", { op: "cancel", id })).toBe("not_found");

  expect(held.seen.aborted).toBe(false);
  expect(await controlCall(w, mine, "r2", { op: "list" })).toEqual([{ id, agent: "helper", status: "running" }]);
  held.release();
  const reported = await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));
  expect(reported.text).toContain("answer: hold");
});

test("a child's origin is the conversation its tree descends from, two delegations deep too: its tools and prepare see it, after a restart as well", async () => {
  prepared.length = 0;
  const db = await records();
  const first = hold("safe");
  const w1 = await db.worker({ tools: { delegate, hold: first.tool } });
  const conversation = await w1.conversation("assistant");
  const origin = originOf(conversation);
  const deep = JSON.stringify({ agent: "helper", task: "hold" });

  // assistant -> relay -> helper, each waiting.
  await w1.dispatch("r1", `call: delegate ${JSON.stringify({ agent: "relay", task: `call: delegate ${deep}` })}`, conversation);
  await first.started;
  expect(first.seen.agent).toBe("helper");
  expect(first.seen.origin).toEqual(origin);
  expect(prepared.map((each) => [each.agent, each.origin])).toContainEqual(["relay", origin]);
  expect(prepared.every((each) => each.origin?.conversationId === conversation.conversationId)).toBe(true);
  await w1.close();

  // The hold runs again after the restart (replay safe): the child is built from its record, origin included.
  const next = hold("safe");
  next.release();
  const w2 = await db.worker({ tools: { delegate, hold: next.tool } });
  await w2.runtime.resume(conversation, w2.ctx);
  expect((await w2.result("r1")).kind).toBe("completed");
  expect(next.seen.agent).toBe("helper");
  expect(next.seen.origin).toEqual(origin);
  // The conversation a person talks in has none.
  const { harness } = await w2.runtime.opened(w2.ctx);
  expect((await harness.snapshot(ConversationDoc, Number(conversation.conversationId) as ConversationId, toChord(w2.ctx)))?.origin).toBeUndefined();
});

test("a child's ref dropped from the runtime's bounded refs (refsKept) is read back from its record with its origin", async () => {
  const held = hold();
  const w = await (await records()).worker({ tools: { delegate, control, hold: held.tool }, runtime: { refsKept: 1 } });
  const conversation = await w.conversation("assistant");
  const other = await w.conversation("assistant");
  const origin = originOf(conversation);
  const id = await startTask(w, conversation, "r1");
  await held.started;
  expect(held.seen.origin).toEqual(origin);
  Reflect.deleteProperty(held.seen, "origin");

  // A steer makes the child's run call hold again; other conversations' runs take the one place meanwhile.
  expect(await controlCall(w, conversation, "r2", { op: "steer", id, message: "hold" })).toBe("running");
  await w.dispatch("o1", "hello", other);
  await w.result("o1");
  held.release();
  await w.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

  expect(held.seen.agent).toBe("helper");
  expect(held.seen.origin).toEqual(origin);
});

test("run: a completed task's outcome carries the parts of the child's run that answered it", async () => {
  const w = await (await records()).worker({ tools: { delegate, hold: hold().tool } });
  const conversation = await w.conversation("assistant");

  await w.dispatch("r1", 'call: delegate {"agent":"helper","task":"call: ask {}"}', conversation);
  const [outcome] = toolResults((await w.result("r1")).messages);

  expect(JSON.parse(outcome ?? "null")).toEqual({ kind: "completed", text: "", parts: [QUESTION] });
});

test("start: the report brings the child's parts to the parent's answer, once, also after a restart", async () => {
  const db = await records();
  const w1 = await db.worker({ tools: { delegate, hold: hold().tool } });
  const conversation = await w1.conversation("assistant");

  await w1.dispatch("r1", 'call: delegate {"agent":"helper","task":"call: ask {}","wait":false}', conversation);
  const reported = await w1.resultWhere((each) => each.requestId.startsWith(RESULT_REQUEST_PREFIX));

  expect(reported.conversation.conversationId).toBe(conversation.conversationId);
  expect(reported.parts).toEqual([QUESTION]);
  // The parent's agent reads what the person is shown, so as not to repeat it.
  expect(reported.text).toContain("[The person is shown what follows with your answer, as it is: do not repeat it.]");
  expect(reported.text).toContain(QUESTION.fallback);
  // `list` keeps the answer's text, not its parts.
  await w1.dispatch("r2", 'call: control {"op":"list"}', conversation);
  expect(JSON.parse(toolResults((await w1.result("r2")).messages)[0] ?? "null")).toEqual([{ id: expect.any(String) as never, agent: "helper", status: "completed", result: "" }]);
  await w1.close();

  const w2 = await db.worker({ tools: { delegate, hold: hold().tool } });
  await w2.runtime.inspect(w2.ctx);
  await w2.runtime.whenIdle(w2.ctx);
  const logged = (await w2.runtime.submissions.answers.read(undefined, 100)).items.map((item) => item.fact).filter((fact) => fact.requestId.startsWith(RESULT_REQUEST_PREFIX));
  expect(logged.map((fact) => fact.parts)).toEqual([[QUESTION]]);
  expect(w2.results()).toEqual([]);
});
