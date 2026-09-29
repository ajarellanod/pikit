/**
 * What the adapter does that the Pi-free `agent.runtime` suite cannot see: Pi's messages in a
 * result, one harness per session, idle conversations closed, contexts crossing into Pi, tool replay
 * after a killed worker, and requests found after compaction.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHarness,
  type Context as PiContext,
  JsonlSessionRepo,
  MemorySessionRepo,
  NOOP_TELEMETRY_CONTEXT,
  withTelemetryContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AppEvents,
  BACKGROUND_CONTEXT,
  createContextKey,
  defineApp,
  defineComponent,
  silentLogger,
  withCancel,
  withContextValue,
} from "@pikit/core";
import { type AgentDefinition, type AgentTool, defineAgent } from "@pikit/contracts";
import { toPi } from "./context.ts";
import { hasRequest, inboundMessage, LANE } from "./inbound.ts";
import { createPiRuntime, modelsFrom, type Provider, type SessionStore } from "./index.ts";
import { createJsonlSessionStore } from "./node/index.ts";
import { slotCount } from "./runtime.ts";
import { holdTool, killMidRun, type ModelRequest, scriptedAgent, scriptedProvider } from "./testing/index.ts";

const ctx = BACKGROUND_CONTEXT;
type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/**
 * A runtime over `sessions`, and the results it reports. By default one scripted agent (with
 * `tools`) on the `faux` provider.
 */
async function setup(
  options: { tools?: AgentTool[]; sessions?: SessionStore; agents?: AgentDefinition[]; providers?: Provider[] } = {},
) {
  const sessions: SessionStore = options.sessions ?? new MemorySessionRepo();
  const results: Result[] = [];
  const waiters: (() => void)[] = [];
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = (result: Result) => {
        results.push(result);
        for (const wake of waiters.splice(0)) wake();
      };
      pikit.on("agent.settled", record);
      pikit.on("agent.failed", record);
    },
  });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const agents = options.agents ?? [{ ...scriptedAgent(holdTool(async () => "unused")), tools: options.tools ?? [] }];
  let opened = 0;
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => agents.find((agent) => agent.name === name),
    models: modelsFrom(options.providers ?? [scriptedProvider()]),
    events: app.context(),
    onHarness: () => void opened++,
  });
  const conversation = async (agent = agents[0]?.name ?? "scripted") => {
    const session = await sessions.create({ cwd: "/" }, ctx);
    await session.close(ctx);
    return { key: `test:${session.metadata.id}`, agent, sessionId: session.metadata.id };
  };
  const result = async (requestId: string): Promise<Result> => {
    for (;;) {
      const found = results.find((r) => r.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { app, runtime, sessions, conversation, result, opens: () => opened };
}

describe("results", () => {
  test("a result carries exactly the messages its run added, the inbound one as a Pi custom message", async () => {
    const s = await setup();
    const conversation = await s.conversation();
    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "one" }, s.app.context());
    await s.result("r1");
    await s.runtime.dispatch({ requestId: "r2", conversation, prompt: "two" }, s.app.context());

    const second = await s.result("r2");

    expect(second.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
    expect(second.messages[0]).toMatchObject({ customType: "pikit.inbound", details: { requestId: "r2" }, content: "two" });
    expect(second.text).toBe("answer: two");
    await s.runtime.close(s.app.context());
  });

  test("an unknown agent rejects the dispatch", async () => {
    const s = await setup();
    const conversation = await s.conversation();

    await expect(
      s.runtime.dispatch({ requestId: "r1", conversation: { ...conversation, agent: "nobody" }, prompt: "hi" }, s.app.context()),
    ).rejects.toThrow('no agent.definition "nobody"');
    await s.runtime.close(s.app.context());
  });
});

describe("conversations", () => {
  test("one conversation is one harness over its own session, and it closes when idle", async () => {
    const s = await setup();
    const a = await s.conversation();
    const b = await s.conversation();

    await s.runtime.dispatch({ requestId: "r1", conversation: a, prompt: "hello" }, s.app.context());
    await s.result("r1");
    await s.runtime.dispatch({ requestId: "r2", conversation: a, prompt: "again" }, s.app.context());
    await s.result("r2");

    // Idle between the two messages: closed, then opened again (an idle conversation holds no
    // open session: MANIFESTO, principle 2).
    expect(s.opens()).toBe(2);
    const stats = async (sessionId: string) => {
      const metadata = (await s.sessions.list(undefined, ctx)).find((m: { id: string }) => m.id === sessionId);
      const session = await s.sessions.open(metadata, ctx);
      const { messageCount } = await session.getStats(ctx);
      await session.close(ctx);
      return messageCount;
    };
    expect(await stats(a.sessionId)).toBe(4);
    expect(await stats(b.sessionId)).toBe(0);
    await s.runtime.close(s.app.context());
  });

  test("a closed conversation leaves nothing behind in the runtime", async () => {
    const s = await setup();
    const conversations = await Promise.all([1, 2, 3].map(() => s.conversation()));

    for (const [i, conversation] of conversations.entries()) {
      await s.runtime.dispatch({ requestId: `r${i}`, conversation, prompt: "hello" }, s.app.context());
      await s.result(`r${i}`);
    }
    // A duplicate opens and closes the conversation again, with no run.
    const [first] = conversations;
    if (first === undefined) throw new Error("expected conversations");
    await s.runtime.dispatch({ requestId: "r0", conversation: first, prompt: "hello" }, s.app.context());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(slotCount.get(s.runtime)?.()).toBe(0);
    await s.runtime.close(s.app.context());
  });
});

describe("closing and event order", () => {
  test("close() while a dispatch is opening its conversation: nothing is left open, no run is driven", async () => {
    const store = new MemorySessionRepo();
    let open = 0;
    const openSession = store.open.bind(store);
    store.open = async (metadata, context) => {
      // Slow, so close() runs while the conversation opens.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const session = await openSession(metadata, context);
      open++;
      const closeSession = session.close.bind(session);
      session.close = (closeContext) => {
        open--;
        return closeSession(closeContext);
      };
      return session;
    };
    let requests = 0;
    const s = await setup({ sessions: store, providers: [scriptedProvider({ onRequest: () => void requests++ })] });
    const conversation = await s.conversation();

    const dispatched = s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, s.app.context());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.runtime.close(s.app.context());

    expect(open).toBe(0);
    await expect(dispatched).rejects.toThrow("agent.runtime is closed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toBe(0);
    expect(open).toBe(0);
  });

  test("agent.started comes before the run's result, even when agent.dispatched is slow to listen", async () => {
    const order: string[] = [];
    const observer = defineComponent({
      name: "order",
      setup(pikit) {
        pikit.on("agent.dispatched", async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push("dispatched");
        });
        pikit.on("agent.started", () => void order.push("started"));
        pikit.on("agent.settled", () => void order.push("settled"));
      },
    });
    const app = await defineApp({ components: [observer], logger: silentLogger }).create();
    const sessions: SessionStore = new MemorySessionRepo();
    const agent = scriptedAgent(holdTool(async () => "unused"));
    const runtime = createPiRuntime({
      sessions,
      agent: (name) => (name === agent.name ? agent : undefined),
      models: modelsFrom([scriptedProvider()]),
      events: app.context(),
    });
    const session = await sessions.create({ cwd: "/" }, ctx);
    await session.close(ctx);
    const conversation = { key: "test:order", agent: agent.name, sessionId: session.metadata.id };

    await runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, app.context());
    for (let i = 0; i < 50 && !order.includes("settled"); i++) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(order).toEqual(["dispatched", "started", "settled"]);
    await runtime.close(app.context());
  });
});

describe("models", () => {
  test("each agent runs on the provider its model names", async () => {
    const support = defineAgent({ name: "support", model: "faux/scripted" });
    const sales = defineAgent({ name: "sales", model: "other/scripted" });
    const s = await setup({ agents: [support, sales], providers: [scriptedProvider(), scriptedProvider({ id: "other" })] });

    await s.runtime.dispatch({ requestId: "r1", conversation: await s.conversation("support"), prompt: "hi" }, s.app.context());
    await s.runtime.dispatch({ requestId: "r2", conversation: await s.conversation("sales"), prompt: "hi" }, s.app.context());

    const providerOf = async (requestId: string) =>
      (await s.result(requestId)).messages.flatMap((message) => (message.role === "assistant" ? [message.provider] : []));
    expect(await providerOf("r1")).toEqual(["faux"]);
    expect(await providerOf("r2")).toEqual(["other"]);
    await s.runtime.close(s.app.context());
  });
});

describe("caches", () => {
  test("a busy conversation reuses its open harness: a queued message opens nothing", async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const released = new Promise<string>((resolve) => (release = () => resolve("released")));
    const s = await setup({ tools: [holdTool(() => (started(), released))] });
    const conversation = await s.conversation();

    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, s.app.context());
    await running;
    const queued = await s.runtime.dispatch({ requestId: "r2", conversation, prompt: "and this" }, s.app.context());
    release();
    await s.result("r1");

    expect(queued.kind).toBe("queued");
    expect(s.opens()).toBe(1);
    await s.runtime.close(s.app.context());
  });

  test("reopening an idle conversation sends the same prefix, so the provider's prompt cache still hits", async () => {
    const requests: ModelRequest[] = [];
    const s = await setup({ providers: [scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })] });
    const conversation = await s.conversation();

    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "one" }, s.app.context());
    await s.result("r1");
    await s.runtime.dispatch({ requestId: "r2", conversation, prompt: "two" }, s.app.context());
    const second = await s.result("r2");

    // Closed in between (MANIFESTO, principle 2), then reopened from the session.
    expect(s.opens()).toBe(2);
    const [before, after] = requests;
    if (before === undefined || after === undefined) throw new Error("expected two model requests");
    const { messages: beforeMessages, ...beforeRest } = before;
    const { messages: afterMessages, ...afterRest } = after;
    // Same system prompt and tools, and the earlier conversation as an unchanged prefix.
    expect(afterRest).toEqual(beforeRest);
    expect(afterMessages.slice(0, beforeMessages.length)).toEqual(beforeMessages);
    const answer = second.messages.find((message) => message.role === "assistant");
    if (answer?.role !== "assistant") throw new Error("expected an answer");
    expect(answer.usage.cacheRead).toBeGreaterThan(0);
    await s.runtime.close(s.app.context());
  });
});

describe("contexts (SPEC K5)", () => {
  test("a pikit context keeps its cancellation when Pi derives from it only through the bridge", () => {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);

    // Pi derives telemetry contexts with Chord's withContextValue.
    const unbridged = withTelemetryContext(NOOP_TELEMETRY_CONTEXT, context);
    const bridged = withTelemetryContext(NOOP_TELEMETRY_CONTEXT, toPi(context));

    cancel();
    expect(unbridged.abortSignal).toBeUndefined();
    expect(bridged.abortSignal?.aborted).toBe(true);
  });

  test("the caller's values reach tools; its cancellation does not, abort() does", async () => {
    const TENANT = createContextKey<string>("tenant");
    let seen!: (context: PiContext) => void;
    const toolContext = new Promise<PiContext>((resolve) => (seen = resolve));
    const hold = holdTool(
      (context) =>
        new Promise<string>((_, reject) => {
          seen(context);
          context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
        }),
    );
    const s = await setup({ tools: [hold] });
    const conversation = await s.conversation();
    const { context, cancel } = withCancel(withContextValue(TENANT, "acme", BACKGROUND_CONTEXT));

    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, s.app.context(context));
    const inTool = await toolContext;
    expect(inTool.value(TENANT)).toBe("acme");
    cancel();
    expect(inTool.abortSignal?.aborted).toBe(false);

    await s.runtime.abort(conversation, s.app.context());

    // Cooperative: abort() returned because the tool honoured its signal.
    expect(inTool.abortSignal?.aborted).toBe(true);
    expect((await s.result("r1")).kind).toBe("aborted");
    await s.runtime.close(s.app.context());
  });
});

describe("opening a conversation's session", () => {
  /** Counts the store's listings: each one reads every session file it holds. */
  const countLists = (store: SessionStore): (() => number) => {
    let lists = 0;
    const list = store.list.bind(store);
    store.list = (options, context) => {
      lists++;
      return list(options, context);
    };
    return () => lists;
  };

  test("a store with find is never listed, however often a conversation closes and opens again", async () => {
    const root = mkdtempSync(join(tmpdir(), "pikit-find-"));
    try {
      const sessions = createJsonlSessionStore({ root, cwd: root });
      const lists = countLists(sessions);
      const s = await setup({ sessions });
      const conversation = await s.conversation();
      for (const requestId of ["r1", "r2", "r3"]) {
        await s.runtime.dispatch({ requestId, conversation, prompt: requestId }, s.app.context());
        expect((await s.result(requestId)).kind).toBe("completed");
      }
      // Idle between messages, so each message opened the conversation again: three opens, no listing.
      expect(s.opens()).toBe(3);
      expect(lists()).toBe(0);
      await s.runtime.close(s.app.context());
      await sessions.close(BACKGROUND_CONTEXT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store without find is listed to open a conversation", async () => {
    const sessions: SessionStore = new MemorySessionRepo();
    const lists = countLists(sessions);
    const s = await setup({ sessions });
    const conversation = await s.conversation();
    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "one" }, s.app.context());
    await s.result("r1");
    expect(lists()).toBe(1);
    await s.runtime.close(s.app.context());
  });
});

describe("a killed worker (replay is Pi's)", () => {
  test("replay: safe — the interrupted tool runs again in the new worker and the run completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pikit-replay-"));
    try {
      const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
      let runs = 0;
      const s = await setup({ sessions, tools: [holdTool(async () => `run ${++runs}`, "safe")] });
      const conversation = await s.conversation();
      await killMidRun(root, conversation.sessionId, "r-killed", "safe");

      await s.runtime.resume(conversation, s.app.context());

      const result = await s.result("r-killed");
      expect(result.kind).toBe("completed");
      expect(runs).toBe(1);
      await s.runtime.close(s.app.context());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("replay: never — the tool is not run again; Pi reports it interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "pikit-replay-"));
    try {
      const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
      let runs = 0;
      const s = await setup({ sessions, tools: [holdTool(async () => `run ${++runs}`, "never")] });
      const conversation = await s.conversation();
      await killMidRun(root, conversation.sessionId, "r-killed", "never");

      await s.runtime.resume(conversation, s.app.context());

      const result = await s.result("r-killed");
      expect(result.kind).toBe("completed");
      expect(runs).toBe(0);
      const toolResult = result.messages.find((message) => message.role === "toolResult");
      expect(JSON.stringify(toolResult)).toContain("interrupted");
      await s.runtime.close(s.app.context());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("messages left in Pi's inbox (pi-gaps.test.ts, gap 2)", () => {
  /** A conversation whose worker died after `steer` and before `accept`: its message waits in the inbox. */
  async function steeredAndDied(s: Awaited<ReturnType<typeof setup>>) {
    const conversation = await s.conversation();
    const metadata = (await s.sessions.list(undefined, ctx)).find((m: { id: string }) => m.id === conversation.sessionId);
    const session = await s.sessions.open(metadata, ctx);
    const models = modelsFrom([scriptedProvider()]);
    const model = models.getModel("faux", "scripted");
    if (model === undefined) throw new Error("faux/scripted missing");
    const { harness } = await AgentHarness.create({ session, models, model }, ctx);
    const lane = await harness.lane(LANE, ctx);
    const steered = await lane.steer(inboundMessage("r1", "lost"), undefined, ctx);
    if (!steered.ok) throw steered.error;
    await harness.close(ctx);
    return conversation;
  }

  test("a message steered by a worker that died before accept() is answered on redelivery", async () => {
    const s = await setup();
    const conversation = await steeredAndDied(s);

    const again = await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "lost" }, s.app.context());

    expect(again.kind).toBe("duplicate");
    const result = await s.result("r1");
    expect([result.kind, result.text, result.requestIds]).toEqual(["completed", "answer: lost", ["r1"]]);
    await s.runtime.close(s.app.context());
  });

  test("... and when its conversation is resumed, with no message at all", async () => {
    const s = await setup();
    const conversation = await steeredAndDied(s);

    await s.runtime.resume(conversation, s.app.context());

    expect((await s.result("r1")).text).toBe("answer: lost");
    await s.runtime.close(s.app.context());
  });

  test("a queued run that fails too is not started again: its messages left the inbox", async () => {
    let requests = 0;
    let release!: () => void;
    const released = new Promise<string>((resolve) => (release = () => resolve("scripted failure")));
    // Every model call fails; the first one only once released.
    const fail = () => (requests === 1 ? released : Promise.resolve("scripted failure"));
    const s = await setup({ providers: [scriptedProvider({ onRequest: () => void requests++, fail })] });
    const conversation = await s.conversation();

    await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "one" }, s.app.context());
    while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const queued = await s.runtime.dispatch({ requestId: "r2", conversation, prompt: "two" }, s.app.context());
    release();

    expect(queued.kind).toBe("queued");
    expect((await s.result("r1")).requestIds).toEqual(["r1"]);
    const second = await s.result("r2");
    expect([second.kind, second.requestIds]).toEqual(["failed", ["r2"]]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toBe(2);
    await s.runtime.close(s.app.context());
  });
});

describe("inbound messages", () => {
  test("compaction keeps requests findable, and the conversation goes on after it", async () => {
    const session = await new MemorySessionRepo().create({}, ctx);
    const models = modelsFrom([scriptedProvider()]);
    const model = models.getModel("faux", "scripted");
    if (model === undefined) throw new Error("faux/scripted missing");
    const { harness } = await AgentHarness.create({ session, models, model }, ctx);
    await harness.setCompactionSettings({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, ctx);
    const lane = await harness.lane(LANE, ctx);
    for (const [id, text] of [["r1", "first"], ["r2", "second"], ["r3", "third"]] as const) {
      await lane.prompt(inboundMessage(id, text), ctx);
    }

    const compacted = await lane.compact(undefined, ctx);

    if (!compacted.ok) throw compacted.error;
    expect(compacted.value.compaction.status).toBe("completed");
    expect(await hasRequest(session, lane, "r1", ctx)).toBe(true);
    const after = await lane.prompt(inboundMessage("r4", "fourth"), ctx);
    expect(after.ok && "status" in after.value && after.value.status).toBe("completed");
    await harness.close(ctx);
  });
});
