/**
 * tool-delegate on Cloudflare: a conversation object's App with storage-do, actors-do (its
 * `actor.inbox` and `wakeups`), runtime-pi driving its runs in wakeups, and the scripted model. The
 * assistant delegates to the helper: the task is a child conversation in the same object's storage
 * (pi-durable's subagents), driven by the same alarm. Waited for, its answer is the call's; not waited
 * for, a background task reports it to the assistant, whose answer is announced like any other; the
 * assistant lists it and cancels it, and hears once that it stopped. The child knows the conversation
 * it works for (its origin), and what it asks the person comes back with the assistant's answer.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, CONVERSATION, type ConversationOrigin, type ConversationRef, defineAgent, type MessagePart } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { defineTool, type ToolRegistration, withParts } from "@pikit/pi-adapter/tools";
import Type from "typebox";
import { afterEach, expect, it } from "vitest";
import { vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import toolDelegate from "../../../registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts";
import { unframed } from "../../../registry/components/tool-delegate/unframed.test-support.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  await resetObjects();
});

type Result = { requestId: string; text: string | undefined; tools: string[]; parts?: readonly MessagePart[] | undefined };

/** The question the helper's `ask` asks. */
const QUESTION = { type: "question", fallback: "Go ahead? Answer yes or no." } as unknown as MessagePart;
/** The origin each call of the helper's `ask` read from its conversation, and its key. */
const origins: (ConversationOrigin | undefined)[] = [];
const keys: (string | undefined)[] = [];

/** The text of the tool results a run added. */
const toolResults = (messages: readonly unknown[]): string[] =>
  (messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

/** The assistant (it delegates) and the helper (`hold` returns once released, or fails when its run stops), on the scripted model. */
function agents(held: { released: Promise<void> }) {
  const assistant = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate", "delegate_tasks", "delegate_cancel"] });
  const hold = holdTool(
    (context) =>
      new Promise<string>((resolve, reject) => {
        context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
        void held.released.then(() => resolve("released"));
      }),
  );
  const ask = defineTool({
    name: "ask",
    description: "Asks the person",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, _api, context) => {
      origins.push(context.value(CONVERSATION)?.origin);
      keys.push(context.value(CONVERSATION)?.key);
      return withParts({ output: [{ type: "text", text: "Asked." }], control: { terminate: true } }, [QUESTION]);
    },
  }) as unknown as ToolRegistration;
  const helper = defineAgent({ name: "helper", model: "faux/scripted", tools: [hold, ask] });
  // The helper reads its task without delegate's framing: the scripted rules match a message whole.
  const provider = unframed(scriptedProvider());
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => [assistant, helper].forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/** A channel's object half: admits each message to the assistant (one conversation per key), and records every announced result. */
function channelActor(results: Result[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      const known = new Map<string, string>();
      pikit.on("agent.settled", (result) => void results.push({ requestId: result.requestId, text: result.text, tools: toolResults(result.messages), parts: result.parts }));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversationId = known.get(key) ?? (await conversations.get().create(ctx));
            known.set(key, conversationId);
            const conversation: ConversationRef = { key, agent: "assistant", conversationId };
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text, sender: { channel: "test", id: "alice" } }, ctx);
          });
        },
      };
    },
  });
}

async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [actorsDo, channel], config: { "actors-do": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    send: (key: string, message: { id: string; text: string }) => mailbox?.send(key, "test.message", message, worker.context()),
    stop: () => worker.stop(),
  };
}

function compose(results: Result[], held: { released: Promise<void> }, from?: string[]) {
  composeObjects([storageDo, actorsDo, ...agents(held), toolDelegate, runtimePi, channelActor(results)], {
    "tool-delegate": { agents: [{ name: "helper", description: "Helps.", ...(from !== undefined && { from }) }] },
  });
}

it("delegate waits for the helper, a child conversation in the same object, driven by its alarm", async () => {
  const results: Result[] = [];
  compose(results, { released: Promise.resolve() });
  const worker = await workerApp();
  try {
    await worker.send(`test:${crypto.randomUUID()}`, { id: "m1", text: 'call: delegate {"agent":"helper","task":"hold"}' });
    // The assistant's run ends once its tool has the helper's answer; the helper's run is not announced.
    await vi.waitFor(() => expect(results.map((each) => each.requestId)).toEqual(["m1"]), { timeout: 10_000 });
  } finally {
    await worker.stop();
  }
});

it("delegate with wait: false: the assistant answers at once, and the helper's answer comes back as a message of its own", async () => {
  const results: Result[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  compose(results, { released });
  const worker = await workerApp();
  try {
    await worker.send(`test:${crypto.randomUUID()}`, { id: "m1", text: 'call: delegate {"agent":"helper","task":"hold","wait":false}' });
    await vi.waitFor(() => expect(results.map((each) => each.requestId)).toEqual(["m1"]), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect(results.map((each) => each.requestId.split(":")[0])).toEqual(["m1", "delegate-result"]), { timeout: 10_000 });
    expect(results[1]?.text).toContain('[The agent "helper" finished the task you delegated to it.');
  } finally {
    await worker.stop();
  }
});

it("the assistant lists the task it did not wait for and cancels it; it hears once that it stopped", async () => {
  const results: Result[] = [];
  compose(results, { released: new Promise<void>(() => {}) });
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  const of = (requestId: string) => results.find((each) => each.requestId === requestId);
  try {
    await worker.send(key, { id: "m1", text: 'call: delegate {"agent":"helper","task":"hold","wait":false}' });
    await vi.waitFor(() => expect(of("m1")).toBeDefined(), { timeout: 10_000 });
    const id = /^The task "(\d+)"/.exec(of("m1")?.tools[0] ?? "")?.[1];
    expect(id).toBeDefined();

    await worker.send(key, { id: "m2", text: "call: delegate_tasks {}" });
    await vi.waitFor(() => expect(of("m2")?.tools).toEqual([`- ${id}: the agent "helper", running`]), { timeout: 10_000 });

    await worker.send(key, { id: "m3", text: `call: delegate_cancel ${JSON.stringify({ id })}` });
    await vi.waitFor(() => expect(results.some((each) => each.requestId.startsWith("delegate-result:"))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(of("m3")?.tools).toEqual([`The task "${id}" is stopped.`]), { timeout: 10_000 });
    expect(results.find((each) => each.requestId.startsWith("delegate-result:"))?.text).toContain('[The task you delegated to the agent "helper" was stopped before it answered.]');

    await worker.send(key, { id: "m4", text: `call: delegate_tasks ${JSON.stringify({ id })}` });
    await vi.waitFor(() => expect(of("m4")?.tools).toEqual([`- ${id}: the agent "helper", aborted`]), { timeout: 10_000 });
    expect(results.filter((each) => each.requestId.startsWith("delegate-result:"))).toHaveLength(1);
  } finally {
    await worker.stop();
  }
});

it("a background task's child works for the assistant's conversation (its origin), and its question comes back with the assistant's answer", async () => {
  const results: Result[] = [];
  origins.length = 0;
  keys.length = 0;
  compose(results, { released: Promise.resolve() });
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(key, { id: "m1", text: 'call: delegate {"agent":"helper","task":"call: ask {}","wait":false}' });
    await vi.waitFor(() => expect(results.map((each) => each.requestId.split(":")[0])).toEqual(["m1", "delegate-result"]), { timeout: 10_000 });
    expect(origins).toEqual([expect.objectContaining({ key, agent: "assistant" })]);
    // Its key carries the agents above it: the assistant.
    expect(keys).toEqual([expect.stringMatching(/^delegate:1:assistant:/)]);
    expect(results[1]?.parts).toEqual([QUESTION]);
  } finally {
    await worker.stop();
  }
});

it("a helper that takes tasks only from another agent refuses the assistant's, and never runs", async () => {
  const results: Result[] = [];
  origins.length = 0;
  compose(results, { released: Promise.resolve() }, ["helper"]);
  const worker = await workerApp();
  try {
    await worker.send(`test:${crypto.randomUUID()}`, { id: "m1", text: 'call: delegate {"agent":"helper","task":"call: ask {}"}' });
    await vi.waitFor(() => expect(results.map((each) => each.requestId)).toEqual(["m1"]), { timeout: 10_000 });
    expect(results[0]?.tools[0]).toContain('the agent "helper" takes tasks only from helper; this conversation (assistant) may not delegate to it');
    expect(origins).toEqual([]);
  } finally {
    await worker.stop();
  }
});
