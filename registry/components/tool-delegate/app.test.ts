/**
 * tool-delegate in a real App: runtime-pi runs the agents on a SQLite file and the model is the scripted
 * faux provider (`faux/scripted`: `call: <tool> <json>` calls a tool, `hold` calls the `hold` tool,
 * anything else is answered `answer: <message>`). `assistant` names `delegate` and hands tasks to
 * `helper`, which runs in a child conversation of the assistant's.
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentDefinition, type AgentRuntime, type AgentTool, CONVERSATION, type ConversationRef, defineAgent, RUN_REQUESTS, type RunRequest } from "@pikit/contracts";
import { holdTool, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import toolDelegate from "./files/src/pikit/tool-delegate/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/** The helper's `hold`: blocks until released (or its run stops), and records the requests its run took and its conversation's key. */
function hold() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const seen: (readonly RunRequest[] | undefined)[] = [];
  const keys: (string | undefined)[] = [];
  const tool = holdTool(async (context) => {
    seen.push(await context.value(RUN_REQUESTS)?.list(context));
    keys.push(context.value(CONVERSATION)?.key);
    started();
    await new Promise<void>((resolve, reject) => {
      const signal = context.abortSignal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void released.then(resolve);
    });
    return "released";
  });
  return { tool, started: holding, release: () => release(), seen, keys };
}

const agents = (helperTools: AgentDefinition["tools"] = []) => [
  defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate", "delegate_tasks", "delegate_steer", "delegate_cancel"] }),
  defineAgent({ name: "helper", model: "faux/scripted", tools: helperTools }),
];

/** An App over the database in `dir`; a second one over the same `dir` is the next worker. */
async function start(dir: string, list: AgentDefinition[], delegateConfig: Record<string, unknown> = {}) {
  const results: Result[] = [];
  let reached: { runtime: AgentRuntime; create: () => Promise<string> } | undefined;
  const components = [
    sqliteStorage(join(dir, "pikit.db")),
    defineComponent({ name: "agents-test", setup: (pikit) => list.forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) }),
    defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider()) }),
    toolDelegate,
    runtimePi,
    defineComponent({
      name: "observer",
      setup(pikit) {
        const runtime = pikit.use("agent.runtime");
        const conversations = pikit.use("agent.conversations");
        pikit.on("agent.settled", (result) => void results.push(result));
        pikit.on("agent.failed", (result) => void results.push(result));
        return { start: (ctx) => void (reached = { runtime: runtime.get(), create: () => conversations.get().create(ctx) }) };
      },
    }),
  ];
  const config = { "tool-delegate": { agents: [{ name: "helper", description: "Helps." }], ...delegateConfig } };
  const app: App = await defineApp({ components, config, logger: silentLogger }).create();
  await app.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  cleanup.push(stop);
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();
  const until = async (match: (result: Result) => boolean, what: string): Promise<Result> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = results.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; results: ${JSON.stringify(results.map((r) => [r.conversation.key, r.requestId, r.kind]))}`);
      await Bun.sleep(5);
    }
  };
  return {
    app,
    stop,
    runtime: () => live().runtime,
    async ask(key: string, prompt: string, requestId = `${key}:1`, agent = "assistant"): Promise<ConversationRef> {
      const conversation = { key, agent, conversationId: await live().create() };
      await live().runtime.dispatch({ requestId, conversation, prompt, sender: { channel: "test", id: "alice" } }, app.context());
      return conversation;
    },
    /** Sends `prompt` to `conversation` again, and resolves with its run's result. */
    async say(conversation: ConversationRef, prompt: string, requestId: string): Promise<Result> {
      await live().runtime.dispatch({ requestId, conversation, prompt, sender: { channel: "test", id: "alice" } }, app.context());
      return until((r) => r.requestId === requestId, `the result of ${requestId}`);
    },
    results: () => results,
    result: (requestId: string) => until((r) => r.requestId === requestId, `the result of ${requestId}`),
    resultWhere: (match: (result: Result) => boolean) => until(match, "a matching result"),
  };
}

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-delegate-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The text of the tool results a run added. */
const toolResults = (result: Result): string[] =>
  (result.messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

test("delegate waits for the helper's answer, which runs in a child conversation, its sender the delegating agent", async () => {
  const held = hold();
  held.release();
  const s = await start(directory(), agents([held.tool as AgentTool]));

  await s.ask("test:1", 'call: delegate {"agent":"helper","task":"hold"}');
  const result = await s.result("test:1:1");

  expect(result.kind).toBe("completed");
  expect(toolResults(result)).toEqual(['The agent "helper" answered:\n\nanswer: hold']);
  expect(held.seen).toEqual([[{ requestId: expect.stringMatching(/^delegate:/) as never, sender: { channel: "delegate", id: "assistant" } }]]);
});

test("delegate with wait: false returns at once; the helper's answer arrives later in the conversation, as a message", async () => {
  const held = hold();
  const s = await start(directory(), agents([held.tool as AgentTool]));

  const conversation = await s.ask("test:2", 'call: delegate {"agent":"helper","task":"hold","wait":false}');
  const first = await s.result("test:2:1");
  expect(toolResults(first)[0]).toMatch(/^The task "\d+" is with the agent "helper" now\./);
  await held.started;
  held.release();

  const reported = await s.resultWhere((r) => r.requestId.startsWith("delegate-result:"));
  expect(reported.conversation.conversationId).toBe(conversation.conversationId);
  expect(reported.text).toContain('[The agent "helper" finished the task you delegated to it.');
  expect(reported.text).toContain("answer: hold");
});

test("the tasks not waited for: listed, steered and cancelled by their own conversation only, and a cancel is reported once", async () => {
  const held = hold();
  const s = await start(directory(), agents([held.tool as AgentTool]));
  const conversation = await s.ask("test:5", 'call: delegate {"agent":"helper","task":"hold","wait":false}');
  const id = /^The task "(\d+)"/.exec(toolResults(await s.result("test:5:1"))[0] ?? "")?.[1] ?? "";
  await held.started;

  expect(toolResults(await s.say(conversation, "call: delegate_tasks {}", "test:5:2"))).toEqual([`- ${id}: the agent "helper", running`]);
  expect(toolResults(await s.say(conversation, `call: delegate_steer ${JSON.stringify({ id, message: "also this" })}`, "test:5:3"))[0]).toStartWith(`The message is with the task "${id}".`);
  // Another conversation does not see it, and cannot stop it.
  const other = await s.ask("test:6", "call: delegate_tasks {}");
  expect(toolResults(await s.result("test:6:1"))).toEqual(["No task was handed over from this conversation without waiting."]);
  expect(toolResults(await s.say(other, `call: delegate_cancel ${JSON.stringify({ id })}`, "test:6:2"))[0]).toContain(`there is no task "${id}" started from this conversation`);

  expect(toolResults(await s.say(conversation, `call: delegate_cancel ${JSON.stringify({ id })}`, "test:5:4"))).toEqual([`The task "${id}" is stopped.`]);
  const reported = await s.resultWhere((r) => r.requestId.startsWith("delegate-result:"));
  expect(reported.conversation.conversationId).toBe(conversation.conversationId);
  expect(reported.text).toContain('[The task you delegated to the agent "helper" was stopped before it answered.]');
  expect(toolResults(await s.say(conversation, `call: delegate_cancel ${JSON.stringify({ id })}`, "test:5:5"))).toEqual([`The task "${id}" is stopped.`]);
  expect(toolResults(await s.say(conversation, `call: delegate_tasks ${JSON.stringify({ id })}`, "test:5:6"))).toEqual([`- ${id}: the agent "helper", aborted`]);
  expect(s.results().filter((r) => r.requestId.startsWith("delegate-result:"))).toHaveLength(1);
});

test("a task nobody waits for still reports after a restart", async () => {
  const dir = directory();
  const held = hold();
  const first = await start(dir, agents([held.tool as AgentTool]));
  await first.ask("test:3", 'call: delegate {"agent":"helper","task":"hold","wait":false}');
  await first.result("test:3:1");
  await held.started;
  // The App stops while the task runs: the hold is cut, the task stays pending in the records.
  await first.stop();

  const next = await start(dir, agents([hold().tool as AgentTool]));
  const reported = await next.resultWhere((r) => r.requestId.startsWith("delegate-result:"));
  expect(reported.text).toContain('[The agent "helper" finished the task you delegated to it.');
});

test("with maxDepth 1, a delegated task's own delegate call is refused, and its answer still reaches the assistant", async () => {
  const list = [
    defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate"] }),
    defineAgent({ name: "helper", model: "faux/scripted", tools: ["delegate"] }),
  ];
  const s = await start(directory(), list, { maxDepth: 1 });

  const result = await (async () => {
    await s.ask("test:4", `call: delegate ${JSON.stringify({ agent: "helper", task: 'call: delegate {"agent":"helper","task":"deeper"}' })}`);
    return s.result("test:4:1");
  })();

  // The helper's own call was refused; it answered anyway, and its answer is the assistant's tool result.
  expect(result.kind).toBe("completed");
  expect(toolResults(result)[0]).toStartWith('The agent "helper" answered:');
});

/** `developer` takes tasks only from `orchestrator`; `support` and `orchestrator` delegate, and `orchestrator` takes them from anyone. */
async function guarded(developerTool: AgentTool) {
  const list = [
    defineAgent({ name: "support", model: "faux/scripted", tools: ["delegate"] }),
    defineAgent({ name: "orchestrator", model: "faux/scripted", tools: ["delegate"] }),
    defineAgent({ name: "developer", model: "faux/scripted", tools: [developerTool] }),
  ];
  const delegateConfig = {
    agents: [
      { name: "developer", description: "Holds the token.", from: ["orchestrator"] },
      { name: "orchestrator", description: "Plans." },
    ],
    maxDepth: 3,
  };
  return start(directory(), list, delegateConfig);
}

/** A `delegate` call to `agent` with `task`, as the scripted model's prompt. */
const delegateTo = (agent: string, task: string) => `call: delegate ${JSON.stringify({ agent, task })}`;

test("from: the agent it names delegates to the restricted agent, also through a chain wholly in it; the child's key carries the chain", async () => {
  const held = hold();
  held.release();
  const s = await guarded(held.tool as AgentTool);

  await s.ask("test:7", delegateTo("developer", "hold"), "test:7:1", "orchestrator");
  expect(toolResults(await s.result("test:7:1"))).toEqual(['The agent "developer" answered:\n\nanswer: hold']);
  // Two levels: orchestrator, then its child orchestrator.
  await s.ask("test:8", delegateTo("orchestrator", delegateTo("developer", "hold")), "test:8:1", "orchestrator");
  expect((await s.result("test:8:1")).kind).toBe("completed");

  expect(held.keys).toEqual([expect.stringMatching(/^delegate:1:orchestrator:/), expect.stringMatching(/^delegate:2:orchestrator\.orchestrator:/)]);
  expect(held.seen.map((requests) => requests?.[0]?.sender)).toEqual([{ channel: "delegate", id: "orchestrator" }, { channel: "delegate", id: "orchestrator" }]);
});

test("from: another agent is refused, directly or through an allowed agent, and the restricted agent never runs", async () => {
  const held = hold();
  held.release();
  const s = await guarded(held.tool as AgentTool);

  await s.ask("test:9", delegateTo("developer", "hold"), "test:9:1", "support");
  const direct = await s.result("test:9:1");
  expect(direct.kind).toBe("completed");
  expect(toolResults(direct)[0]).toContain('the agent "developer" takes tasks only from orchestrator; this conversation (support) may not delegate to it');
  // Laundering: support hands the task to orchestrator, whose child asks for the developer.
  await s.ask("test:10", delegateTo("orchestrator", delegateTo("developer", "hold")), "test:10:1", "support");
  expect(toolResults(await s.result("test:10:1"))[0]).toStartWith('The agent "orchestrator" answered:');

  expect(held.keys).toEqual([]);
});
