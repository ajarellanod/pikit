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
  type AgentDefinition,
  type AgentTool,
  type AppEvents,
  BACKGROUND_CONTEXT,
  createContextKey,
  defineAgent,
  defineApp,
  defineComponent,
  silentLogger,
  withCancel,
  withContextValue,
} from "@pikit/core";
import { toPi } from "./context.ts";
import { hasRequest, inboundMessage, LANE } from "./inbound.ts";
import { createPiRuntime, modelsFrom, type Provider, type SessionStore } from "./index.ts";
import { createJsonlSessionStore } from "./node/index.ts";
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

    // Idle between the two messages: closed, then opened again (SPEC §7.1, invariant 5).
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

    // Closed in between (SPEC §7.1, invariant 5), then reopened from the session.
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

describe("contexts (SPEC §6.2)", () => {
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

describe("a killed worker (SPEC §8.4: replay is Pi's)", () => {
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
