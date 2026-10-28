/**
 * extension-tracing in a real App: runtime-pi runs the agents on a SQLite file, the model is the
 * scripted faux provider (`faux/scripted`, from `@pikit/pi-adapter/testing`), and the collector is a
 * fake `fetch` that records each POST. An agent that names `tracing` has each run exported as one
 * batch of spans; an agent that does not, none.
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { type AgentDefinition, type AgentRuntime, type AgentTool, type ConversationRef, defineAgent, type HealthStatus, type Sender } from "@pikit/contracts";
import { defineExtension, hook, ToolTask } from "@pikit/pi-adapter/extensions";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { holdTool, recordingBash, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import { defineTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { createExtensionTracing, FLUSH_AT } from "./files/src/pikit/extension-tracing/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A span as the collector received it, its attributes as a plain object. */
type ReceivedSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; status?: { code: number; message?: string }; attributes: Record<string, unknown> };

/** A fake OTLP collector: records each POST, answers each with the next status of `statuses` (then 200), or throws for `"network"`. */
function fakeCollector(statuses: (number | "network")[] = []) {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    posts.push({ url: input, headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
    const status = statuses.shift() ?? 200;
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(status === 200 ? "{}" : "no", { status });
  };
  const batches = () =>
    posts.map((post) => {
      const body = JSON.parse(post.body) as { resourceSpans: { scopeSpans: { spans: (Omit<ReceivedSpan, "attributes"> & { attributes: { key: string; value: Record<string, unknown> }[] })[] }[] }[] };
      return body.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) =>
          scope.spans.map((span) => ({
            ...span,
            attributes: Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? (value.arrayValue as { values: { stringValue: string }[] }).values.map((each) => each.stringValue)])),
          })),
        ),
      ) as ReceivedSpan[];
    });
  return { fetch, posts, batches, spans: () => batches().flat() };
}

const SECRETS: Record<string, string> = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-public",
  LANGFUSE_SECRET_KEY: "sk-lf-0123456789abcdefghij",
  DB_PASSWORD: "hunter2-database-pass",
};

/** The `secrets` capability over `SECRETS`. */
const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => SECRETS[name] }) });

/** A `health` that records each component's last report. */
function healthRecorder() {
  const reports: { status: HealthStatus; reason?: string }[] = [];
  const component = defineComponent({
    name: "health-test",
    setup: (pikit) =>
      pikit.provide("health", {
        reporter: () => ({
          up: () => void reports.push({ status: "up" }),
          degraded: (reason: string) => void reports.push({ status: "degraded", reason }),
          down: (reason: string) => void reports.push({ status: "down", reason }),
        }),
        snapshot: () => ({ status: "up", components: [] }),
      }),
  });
  return { component, reports };
}

/** A logger that records warnings. */
function warnings() {
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = { ...silentLogger, warn: (message, fields) => void lines.push({ message, ...(fields !== undefined && { fields: fields as Record<string, unknown> }) }) };
  return { logger, lines };
}

/** An extension that blocks every `bash` call in its `beforeTool`. */
const blocker = defineComponent({
  name: "blocker-test",
  setup: (pikit) =>
    pikit.provideKeyed("agent.extension", "blocker", defineExtension({ name: "blocker", hooks: [hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "no bash here" } : undefined) })] })),
});

/** A tool that asks to be called again `times` times: each round is a model request and a tool call. */
function loopTool(times: number) {
  let calls = 0;
  return defineTool({
    name: "loop",
    description: "Asks to be called again",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: ++calls < times ? "call: loop {}" : "done" }] }),
  }) as unknown as AgentTool;
}

const agents = [
  defineAgent({ name: "traced", model: "faux/scripted", tools: ["bash", "loop"], extensions: ["tracing"] }),
  defineAgent({ name: "plain", model: "faux/scripted", tools: ["bash"] }),
  // The blocker first (tracing's beforeTool never sees the call), or last (it does).
  defineAgent({ name: "blocked", model: "faux/scripted", tools: ["bash"], extensions: ["blocker", "tracing"] }),
  defineAgent({ name: "blocked-last", model: "faux/scripted", tools: ["bash"], extensions: ["tracing", "blocker"] }),
];

interface StartOptions {
  collector: ReturnType<typeof fakeCollector>;
  config?: Record<string, unknown>;
  agents?: AgentDefinition[];
  extra?: ComponentDefinition[];
  logger?: Logger;
  loops?: number;
  /** The SQLite file; a new one by default. */
  file?: string;
}

function databaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-tracing-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "pikit.db");
}

/** An App with runtime-pi, the agents and extension-tracing; `ask` dispatches a message and waits for the run's end. */
async function start(options: StartOptions) {
  const ran: string[] = [];
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  let reached: { runtime: AgentRuntime; create: () => Promise<string> } | undefined;
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return { start: (ctx) => void (reached = { runtime: runtime.get(), create: () => conversations.get().create(ctx) }) };
    },
  });
  const provider = scriptedProvider();
  const tools = defineComponent({
    name: "tools-test",
    setup(pikit) {
      pikit.provideKeyed("agent.tool", "bash", recordingBash(ran) as AgentTool);
      pikit.provideKeyed("agent.tool", "loop", loopTool(options.loops ?? 3));
      pikit.provide("execution", createLocalExecution({ cwd: tmpdir(), env: {} }));
    },
  });
  const components = [
    sqliteStorage(options.file ?? databaseFile()),
    defineComponent({ name: "agents-test", setup: (pikit) => (options.agents ?? agents).forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) }),
    defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", provider) }),
    tools,
    secrets,
    blocker,
    ...(options.extra ?? []),
    createExtensionTracing({ fetch: options.collector.fetch }),
    runtimePi,
    observer,
  ];
  const config = {
    "extension-tracing": {
      endpoint: "https://langfuse.test/api/public/otel/v1/traces",
      basicAuth: { username: "LANGFUSE_PUBLIC_KEY", password: "LANGFUSE_SECRET_KEY" },
      redact: ["DB_PASSWORD"],
      ...options.config,
    },
  };
  const app = await defineApp({ components, config, logger: options.logger ?? silentLogger }).create();
  await app.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  cleanup.push(stop);
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();

  return {
    ran,
    results,
    stop,
    create: () => live().create(),
    /** Dispatches a message without waiting for its run. */
    async send(conversation: ConversationRef, requestId: string, prompt: string) {
      await live().runtime.dispatch({ requestId, conversation, prompt }, app.context());
    },
    async ask(key: string, agent: string, prompt: string, sender?: Sender, conversationId?: string) {
      const conversation: ConversationRef = { key, agent, conversationId: conversationId ?? (await live().create()) };
      const requestId = `${key}:1`;
      await live().runtime.dispatch({ requestId, conversation, prompt, ...(sender !== undefined && { sender }) }, app.context());
      return { conversation, result: await waitFor(() => results.find((r) => r.requestId === requestId), `the result of ${requestId}`) };
    },
  };
}

async function waitFor<T>(find: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Waits for `count` POSTs, then a little more to see no other comes. */
async function posts(collector: ReturnType<typeof fakeCollector>, count: number) {
  await waitFor(() => collector.posts.length >= count || undefined, `${count} POSTs`);
  await Bun.sleep(50);
  return collector.posts;
}

const byName = (spans: ReceivedSpan[], name: string) => spans.filter((span) => span.name === name);

test("a run is one batch: invoke_agent, a chat span per model request and an execute_tool span, children of the run's span, sent with Basic auth", async () => {
  const collector = fakeCollector();
  const s = await start({ collector });

  const { conversation, result } = await s.ask("telegram:1001", "traced", "bash: ls", { channel: "telegram", id: "1001" });

  expect(result.text).toBe("tool said: ran");
  expect(await posts(collector, 1)).toHaveLength(1);
  const post = collector.posts[0];
  expect(post?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
  expect(post?.headers["content-type"]).toBe("application/json");
  expect(post?.headers.authorization).toBe(`Basic ${btoa("pk-lf-public:sk-lf-0123456789abcdefghij")}`);

  const spans = collector.spans();
  expect(spans.map((span) => span.name).sort()).toEqual(["chat scripted", "chat scripted", "execute_tool bash", "invoke_agent traced"]);
  const [root] = byName(spans, "invoke_agent traced");
  expect(root?.parentSpanId).toBeUndefined();
  for (const span of spans) {
    expect(span.traceId).toBe(root?.traceId as string);
    expect(span.attributes["session.id"]).toBe("telegram:1001");
    expect(span.attributes["langfuse.session.id"]).toBe("telegram:1001");
    expect(span.attributes["user.id"]).toBe("telegram:1001");
    expect(span.attributes["gen_ai.agent.name"]).toBe("traced");
    if (span !== root) expect(span.parentSpanId).toBe(root?.spanId as string);
  }
  expect(root?.attributes).toMatchObject({
    "gen_ai.operation.name": "invoke_agent",
    "pikit.conversation.id": conversation.conversationId,
    "pikit.request.id": "telegram:1001:1",
    "pikit.request.ids": ["telegram:1001:1"],
    "pikit.run.kind": "completed",
    "pikit.run.resumed": false,
  });
  expect(root?.status).toBeUndefined();
  const chat = byName(spans, "chat scripted")[0];
  expect(chat?.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.provider.name": "faux", "gen_ai.request.model": "scripted" });
  expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBeDefined();
  const [tool] = byName(spans, "execute_tool bash");
  expect(tool?.attributes).toMatchObject({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "bash" });
  expect(tool?.attributes["gen_ai.tool.call.id"]).toBeString();
  expect(tool?.status).toBeUndefined();
});

test("no content by default: no prompt, answer, tool argument or result leaves the App", async () => {
  const collector = fakeCollector();
  const s = await start({ collector });

  await s.ask("test:private", "traced", "bash: echo platypus");
  await posts(collector, 1);

  const body = collector.posts.map((post) => post.body).join("\n");
  expect(body).not.toContain("platypus");
  expect(body).not.toContain("tool said");
  expect(body).not.toContain('"ran"');
  for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) expect(body).not.toContain(key);
});

test("captureContent: prompts, answers, arguments and results, with the named secrets' values and token shapes redacted, each capped at 4 KB", async () => {
  const collector = fakeCollector();
  const s = await start({ collector, config: { captureContent: true } });
  const ghp = `ghp_${"a".repeat(36)}`;
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

  await s.ask("test:content", "traced", `bash: echo platypus hunter2-database-pass Bearer abcdefgh12345678 ${ghp} ${jwt} sk-lf-0123456789abcdefghij`);
  await s.ask("test:long", "traced", `answer ${"x".repeat(10_000)}`);
  await posts(collector, 2);

  const body = collector.posts.map((post) => post.body).join("\n");
  for (const secret of ["hunter2-database-pass", "abcdefgh12345678", ghp, jwt, "sk-lf-0123456789abcdefghij"]) expect(body).not.toContain(secret);
  const spans = collector.spans();
  const tool = byName(spans, "execute_tool bash")[0];
  expect(tool?.attributes["gen_ai.tool.call.arguments"]).toBe('{"command":"echo platypus [redacted] Bearer [redacted] [redacted] [redacted] [redacted]"}');
  expect(tool?.attributes["gen_ai.tool.call.result"]).toBe("ran");
  const root = spans.find((span) => span.name === "invoke_agent traced" && span.attributes["pikit.conversation.key"] === "test:content");
  expect(String(root?.attributes["gen_ai.input.messages"])).toContain("echo platypus [redacted]");
  expect(String(root?.attributes["gen_ai.output.messages"])).toContain("tool said: ran");
  for (const span of spans) {
    for (const value of Object.values(span.attributes)) if (typeof value === "string") expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(4_096);
  }
  const long = spans.find((span) => span.name === "chat scripted" && span.attributes["pikit.conversation.key"] === "test:long");
  expect(String(long?.attributes["gen_ai.input.messages"]).endsWith("…")).toBe(true);
});

test("a call another extension's hook blocks is an error span, whatever the extensions' order", async () => {
  const collector = fakeCollector();
  const s = await start({ collector });

  for (const [index, agent] of ["blocked", "blocked-last"].entries()) {
    const { result } = await s.ask(`test:${agent}`, agent, "bash: rm -rf /");

    expect(result.text).toContain("no bash here");
    await posts(collector, index + 1);
    const tools = byName(collector.batches()[index] ?? [], "execute_tool bash");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toEqual({ code: 2, message: "the call did not run" });
    expect(tools[0]?.attributes["error.type"]).toBe("not_run");
  }
  expect(s.ran).toEqual([]);
});

test("a run resumed by the next App continues its trace: the same trace id, its spans under the same run span", async () => {
  const collector = fakeCollector();
  const file = databaseFile();
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const hold = holdTool(async (context) => {
    held();
    await new Promise<void>((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true }));
    return "never";
  });
  const holder = [defineAgent({ name: "holder", model: "faux/scripted", tools: [hold], extensions: ["tracing"] })];

  // The first App sends the model request, starts the tool, and stops mid-run: what it buffered is sent at stop.
  const first = await start({ collector, file, agents: holder });
  const conversationId = await first.create();
  const conversation: ConversationRef = { key: "test:resume", agent: "holder", conversationId };
  await first.send(conversation, "r1", "hold");
  await holding;
  await first.stop();
  const before = collector.spans();
  expect(before.map((span) => span.name)).toEqual(["chat scripted"]);

  // The next App over the same file resumes the run (an interrupted tool result), and ends it.
  const next = await start({ collector, file, agents: holder });
  await waitFor(() => next.results.find((r) => r.conversation.conversationId === conversation.conversationId), "the resumed run's end");
  await posts(collector, 2);

  const spans = collector.spans();
  const [root] = byName(spans, "invoke_agent holder");
  expect(root?.attributes["pikit.run.resumed"]).toBe(true);
  expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([root?.traceId as string]));
  // The chat span the first App sent hangs under the run span the next one sent.
  expect(before[0]?.parentSpanId).toBe(root?.spanId as string);
});

test("a collector that fails never affects the run: one retry, then the batch is dropped, a warning without payload, health degraded", async () => {
  const collector = fakeCollector([500, 500, 503, 200, "network", "network", 400]);
  const health = healthRecorder();
  const log = warnings();
  const s = await start({ collector, extra: [health.component], logger: log.logger });

  // Refused twice: dropped.
  const first = await s.ask("test:a", "traced", "bash: echo platypus");
  expect(first.result.text).toBe("tool said: ran");
  await posts(collector, 2);
  expect(log.lines).toContainEqual({ message: "extension-tracing: a batch of spans was dropped", fields: { spans: 4, reason: "HTTP 500" } });
  expect(health.reports.at(-1)?.status).toBe("degraded");
  expect(JSON.stringify(log.lines)).not.toContain("platypus");

  // Refused once, then taken: up again.
  await s.ask("test:b", "traced", "hello");
  await posts(collector, 4);
  expect(health.reports.at(-1)).toEqual({ status: "up" });

  // Unreachable twice: dropped. A 400 is not tried again.
  await s.ask("test:c", "traced", "hello");
  await posts(collector, 6);
  expect(log.lines.at(-1)).toEqual({ message: "extension-tracing: a batch of spans was dropped", fields: { spans: 2, reason: "TypeError" } });
  const last = await s.ask("test:d", "traced", "hello");
  expect(last.result.text).toBe("answer: hello");
  expect(await posts(collector, 7)).toHaveLength(7);
  expect(log.lines.at(-1)?.fields).toEqual({ spans: 2, reason: "HTTP 400" });
});

test("the buffer holds maxSpans at most: past it the oldest spans are dropped, and that is logged", async () => {
  const collector = fakeCollector();
  const log = warnings();
  const s = await start({ collector, config: { maxSpans: 2 }, logger: log.logger });

  await s.ask("test:cap", "traced", "bash: ls");
  await posts(collector, 1);

  // Four spans (two chats, a tool, the run): the two newest are sent, the run's last.
  expect(collector.spans().map((span) => span.name)).toEqual(["chat scripted", "invoke_agent traced"]);
  expect(log.lines).toContainEqual({ message: "extension-tracing: spans were dropped, the buffer was full", fields: { dropped: 2, maxSpans: 2 } });
});

test("one POST per run, and one more each time 200 spans are buffered before its end", async () => {
  const collector = fakeCollector();
  const rounds = 100;
  const s = await start({ collector, loops: rounds });

  // 100 rounds of a model request and a tool call, then the answer: 202 spans.
  const { result } = await s.ask("test:long-run", "traced", "call: loop {}");
  expect(result.text).toBe("answer: call: loop {}");
  const sent = await posts(collector, 2);

  expect(sent).toHaveLength(2);
  const [early, last] = collector.batches();
  expect(early).toHaveLength(FLUSH_AT);
  expect(last?.map((span) => span.name).at(-1)).toBe("invoke_agent traced");
  expect(collector.spans()).toHaveLength(2 * rounds + 2);
  expect(new Set(collector.spans().map((span) => span.spanId)).size).toBe(2 * rounds + 2);
});

test("an agent that does not name tracing is not traced", async () => {
  const collector = fakeCollector();
  const s = await start({ collector });

  const { result } = await s.ask("test:plain", "plain", "bash: ls");
  expect(result.text).toBe("tool said: ran");
  await Bun.sleep(100);
  expect(collector.posts).toEqual([]);

  // The next traced run's batch holds only its own spans.
  await s.ask("test:traced", "traced", "hello");
  await posts(collector, 1);
  expect(collector.spans().map((span) => span.attributes["gen_ai.agent.name"])).toEqual(["traced", "traced"]);
});
