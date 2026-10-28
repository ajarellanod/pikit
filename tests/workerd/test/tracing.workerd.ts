/**
 * extension-tracing on Cloudflare: in a `PlatformConversation` object (storage-do, actors-do's
 * `actor.inbox` and `wakeups`, runtime-pi driving its runs in the object's alarm, the scripted model,
 * a fake `secrets`), an agent that names `tracing` has its run exported as one batch to a fake
 * collector behind the isolate's `fetch` (the default export, `globalThis.fetch`), with Basic auth.
 * Then a run the object is evicted in the middle of (between two alarms) is ended by the next
 * instance: its spans carry the trace id derived from the conversation and the first request, under
 * the same run span, and the tool call that outlived the eviction keeps the start its first instance
 * wrote in the task's durable memo.
 *
 * `Date` (the apps' clock: the tests and the objects share one isolate) is faked a day ahead in the
 * eviction test, so the alarms runtime-pi asks for do not fire by themselves; the test fires each.
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type ConversationRef, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import tracing from "../../../registry/components/extension-tracing/files/src/pikit/extension-tracing/index.ts";
import { traceIdOf } from "../../../registry/components/extension-tracing/files/src/pikit/extension-tracing/otlp.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  await resetObjects();
});

const ENDPOINT = "https://langfuse.test/api/public/otel/v1/traces";
const DAY = 24 * 60 * 60 * 1_000;

type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] };

/** The collector at `ENDPOINT`, behind the isolate's `fetch`: records each POST. */
function fakeCollector() {
  const posts: { authorization: string | null; spans: Span[] }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== ENDPOINT) return await realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };
    posts.push({ authorization: new Headers(init?.headers).get("authorization"), spans: body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)) });
    return Response.json({});
  };
  return { fetch: fetch as typeof globalThis.fetch, posts };
}

const attribute = (span: Span | undefined, key: string) => {
  const value = span?.attributes.find((each) => each.key === key)?.value;
  return value?.stringValue ?? value?.boolValue ?? value?.intValue;
};

/** What the agent's `hold` does, per test: by default it returns at once. */
let holding: () => Promise<string> = async () => "released";

/** The scripted agent, naming `tracing`, with a `hold` tool safe to run again after an eviction. */
function model(): ComponentDefinition[] {
  const agent = defineAgent({ name: "scripted", model: "faux/scripted", tools: [holdTool(() => holding(), "safe")], extensions: ["tracing"] });
  const provider = scriptedProvider();
  const secrets: Record<string, string> = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-2" };
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
    defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => secrets[name] }) }),
  ];
}

const config = { "extension-tracing": { endpoint: ENDPOINT, basicAuth: { username: "LANGFUSE_PUBLIC_KEY", password: "LANGFUSE_SECRET_KEY" } } };

/** A channel's object half: admits each message to the object's conversation; records the conversation and each answer. */
function channelActor(answers: (string | undefined)[], conversations: ConversationRef[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const runtime = pikit.use("agent.runtime");
      const created = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversation: ConversationRef = { key, agent: "scripted", conversationId: await created.get().create(ctx) };
            conversations.push(conversation);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
        },
      };
    },
  });
}

/** The Worker's App, which sends to the objects through `actor.mailbox`. */
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

const objectOf = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));

it("a run in a conversation's object is exported as one batch to the collector, with Basic auth from secrets", async () => {
  const collector = fakeCollector();
  globalThis.fetch = collector.fetch;
  const answers: (string | undefined)[] = [];
  const conversations: ConversationRef[] = [];
  composeObjects([storageDo, actorsDo, ...model(), tracing, runtimePi, channelActor(answers, conversations)], config);
  const worker = await workerApp();
  try {
    const key = `test:${crypto.randomUUID()}`;
    await worker.send(key, { id: "m1", text: "hello" });
    await vi.waitFor(() => expect(answers).toEqual(["answer: hello"]), { timeout: 10_000 });
    await vi.waitFor(() => expect(collector.posts).toHaveLength(1), { timeout: 10_000 });

    const [post] = collector.posts;
    expect(post?.authorization).toBe(`Basic ${btoa("pk-lf-1:sk-lf-2")}`);
    expect(post?.spans.map((span) => span.name).sort()).toEqual(["chat scripted", "invoke_agent scripted"]);
    const root = post?.spans.find((span) => span.name === "invoke_agent scripted");
    expect(root?.traceId).toBe(await traceIdOf(conversations[0]?.conversationId as string, "m1"));
    expect(attribute(root, "session.id")).toBe(key);
    for (const span of post?.spans ?? []) expect(span.traceId).toBe(root?.traceId as string);
  } finally {
    await worker.stop();
  }
});

it("a run the object is evicted in the middle of is ended by the next instance in the same trace, its tool call keeping the start the first instance wrote", async () => {
  const collector = fakeCollector();
  globalThis.fetch = collector.fetch;
  const answers: (string | undefined)[] = [];
  const conversations: ConversationRef[] = [];
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  // The tool never returns in the first instance: the eviction ends it.
  holding = () => {
    held();
    return new Promise<string>(() => {});
  };
  // Short slices: the alarm that drives the run ends soon and asks again, as on Cloudflare at its deadline.
  composeObjects([storageDo, actorsDo, ...model(), tracing, runtimePi, channelActor(answers, conversations)], { ...config, "actors-do": { sliceMs: 200 } });
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(key, { id: "m1", text: "hold" });
    expect(await runDurableObjectAlarm(objectOf(key))).toBe(true);
    await reached;
    holding = async () => "released";
    const evictedAt = Date.now();

    // Between two alarms: the instance, its in-memory spans and its tool call are gone; the storage stays.
    await evictDurableObject(objectOf(key));
    // A minute later, the next instance runs the tool again (replay safe) and ends the run.
    vi.setSystemTime(evictedAt + 60_000);
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(key));
        expect(answers).toEqual(["answer: hold"]);
      },
      { timeout: 10_000, interval: 200 },
    );
    await vi.waitFor(() => expect(collector.posts).toHaveLength(1), { timeout: 10_000 });

    const spans = collector.posts.flatMap((post) => post.spans);
    const root = spans.find((span) => span.name === "invoke_agent scripted");
    expect(attribute(root, "pikit.run.resumed")).toBe(true);
    expect(root?.traceId).toBe(await traceIdOf(conversations[0]?.conversationId as string, "m1"));
    for (const span of spans) expect(span.traceId).toBe(root?.traceId as string);
    const tool = spans.find((span) => span.name === "execute_tool hold");
    expect(tool?.parentSpanId).toBe(root?.spanId as string);
    // Its start is the first instance's, from the task's memo: before the eviction.
    expect(Number(BigInt(tool?.startTimeUnixNano ?? "0") / 1_000_000n)).toBeLessThanOrEqual(evictedAt);
  } finally {
    holding = async () => "released";
    await worker.stop();
  }
});
