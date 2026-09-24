/**
 * log-events' tests. They are copied with the component and keep running in your project. They need
 * no agent runtime: each test emits the events a runtime would.
 */

import { expect, test } from "bun:test";
import { type AgentResult, type AppEvents, type Clock, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import logEvents from "./index.ts";

interface Line {
  level: string;
  message: string;
  fields?: Record<string, unknown> | undefined;
}

/** A logger that keeps every line, and a clock the test moves. */
function capture() {
  const lines: Line[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, fields });
  const logger: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  let now = 1_000;
  const clock: Clock = { now: () => now, sleep: async () => {} };
  return { lines, logger, clock, advance: (ms: number) => void (now += ms), find: (message: string) => lines.filter((l) => l.message === message) };
}

// Words that must never reach a log line: the prompt, the answer and the error's message.
const PROMPT = "PROMPT-my-card-is-4111";
const ANSWER = "ANSWER-your-balance-is-42";
const ERROR_DETAIL = "ERROR-DETAIL-quoting-the-prompt";

const conversation = { key: "http:c1", agent: "assistant", sessionId: "s1" };
const usage = {
  input: 100,
  output: 20,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens: 180,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

function result(kind: AgentResult["kind"], extra: Partial<AgentResult> = {}): AgentResult {
  return {
    conversation,
    requestId: "r1",
    requestIds: ["r1", "r2"],
    kind,
    text: ANSWER,
    messages: [
      { role: "custom", customType: "pikit.inbound", content: PROMPT, display: true, details: { requestId: "r1" }, timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: ANSWER }],
        api: "faux",
        provider: "faux",
        model: "scripted",
        usage,
        stopReason: "stop",
        timestamp: 0,
      },
    ],
    usage,
    ...extra,
  };
}
const settled = (kind: "completed" | "aborted" = "completed"): AppEvents["agent.settled"] => ({ ...result(kind), kind });
const failed = (): AppEvents["agent.failed"] => ({
  ...result("failed", { error: { code: "provider_error", message: ERROR_DETAIL } }),
  kind: "failed",
});

async function app(logger: Logger, clock?: Clock) {
  const halting = defineComponent({
    name: "halting-test",
    setup: (pikit) => pikit.pipeline("inbound.normalize", () => pikit.halt("looks like spam"), { id: "spam" }),
  });
  return defineApp({ components: [logEvents, halting], logger, ...(clock !== undefined && { clock }) }).create();
}

for (const c of createLifecycleConformance(() => ({ component: logEvents }))) {
  test(`log-events ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const created = await defineApp({ components: [logEvents], logger: silentLogger }).create();

  expect(created.describe().components.find((component) => component.name === "log-events")).toEqual({
    name: "log-events",
    provides: [],
    requires: [],
    optional: [],
  });
});

test("a run logs its dispatch, its start and its end, with duration, tokens and cost", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();

  await ctx.emit("agent.dispatched", { conversation, admission: { kind: "started", requestId: "r1" } });
  await ctx.emit("agent.started", { conversation, requestId: "r1", resumed: false });
  c.advance(250);
  await ctx.emit("agent.dispatched", { conversation, admission: { kind: "queued", requestId: "r2" } });
  await ctx.emit("agent.settled", settled());

  expect(c.lines).toEqual([
    { level: "info", message: "agent.dispatched", fields: { conversation: "http:c1", agent: "assistant", session: "s1", requestId: "r1", admission: "started" } },
    { level: "info", message: "agent.started", fields: { conversation: "http:c1", agent: "assistant", session: "s1", requestId: "r1", resumed: false } },
    { level: "info", message: "agent.dispatched", fields: { conversation: "http:c1", agent: "assistant", session: "s1", requestId: "r2", admission: "queued" } },
    {
      level: "info",
      message: "agent.settled",
      fields: {
        conversation: "http:c1",
        agent: "assistant",
        session: "s1",
        requestId: "r1",
        requestIds: ["r1", "r2"],
        run: "completed",
        messages: 2,
        durationMs: 250,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        totalTokens: 180,
        cost: 0.0033,
      },
    },
  ]);
});

test("a failed run is an error line with its code; an aborted one is a warning", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();

  await ctx.emit("agent.started", { conversation, requestId: "r1", resumed: true });
  c.advance(40);
  await ctx.emit("agent.failed", failed());
  await ctx.emit("agent.settled", settled("aborted"));

  const [fail] = c.find("agent.failed");
  expect(fail).toMatchObject({ level: "error", fields: { run: "failed", errorCode: "provider_error", durationMs: 40, totalTokens: 180 } });
  const [abort] = c.find("agent.settled");
  expect(abort).toMatchObject({ level: "warn", fields: { run: "aborted" } });
  // The start was consumed by the failed run: this end has no start to measure from.
  expect(abort?.fields).not.toHaveProperty("durationMs");
});

test("a run whose start this process never saw logs no duration", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();

  await ctx.emit("agent.settled", settled());

  expect(c.find("agent.settled")[0]?.fields).not.toHaveProperty("durationMs");
  expect(c.find("agent.settled")[0]?.fields).toMatchObject({ requestId: "r1", totalTokens: 180 });
});

test("the start times are a bounded cache: runs that never end in this process are forgotten, oldest first", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();
  for (let i = 0; i <= 10_000; i++) await ctx.emit("agent.started", { conversation, requestId: `r${i}`, resumed: false });
  c.advance(5);

  await ctx.emit("agent.settled", { ...settled(), requestId: "r0" });
  await ctx.emit("agent.settled", { ...settled(), requestId: "r10000" });

  const [oldest, newest] = c.find("agent.settled");
  expect(oldest?.fields).not.toHaveProperty("durationMs");
  expect(newest?.fields).toMatchObject({ durationMs: 5 });
});

test("a reset, a halted pipeline and the runtime's lifecycle each log a line", async () => {
  const c = capture();
  const created = await app(c.logger, c.clock);
  await created.start();

  await created.context().emit("conversation.reset", {
    conversation: { ...conversation, sessionId: "s2" },
    previousSessionId: "s1",
    newSessionId: "s2",
  });
  await created.context().run("inbound.normalize", {
    id: "m1",
    channel: "http",
    conversationId: "c1",
    actor: { id: "someone" },
    text: PROMPT,
    raw: {},
    receivedAt: 0,
  });
  await created.stop();

  expect(c.find("conversation.reset")).toEqual([
    { level: "info", message: "conversation.reset", fields: { conversation: "http:c1", agent: "assistant", session: "s2", previousSession: "s1" } },
  ]);
  expect(c.find("pipeline.halted")).toEqual([
    { level: "info", message: "pipeline.halted", fields: { pipeline: "inbound.normalize", stage: "spam", reason: "looks like spam" } },
  ]);
  expect(c.lines.map((line) => line.message).filter((message) => message.startsWith("runtime."))).toEqual([
    "runtime.starting",
    "runtime.ready",
    "runtime.stopping",
    "runtime.stopped",
  ]);
  expect(JSON.stringify(c.lines)).not.toContain(PROMPT);
});

test("no line carries a prompt, an answer or an error message", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();

  await ctx.emit("agent.dispatched", { conversation, admission: { kind: "started", requestId: "r1" } });
  await ctx.emit("agent.started", { conversation, requestId: "r1", resumed: false });
  await ctx.emit("agent.settled", settled());
  await ctx.emit("agent.failed", failed());

  const printed = JSON.stringify(c.lines);
  expect(c.lines).toHaveLength(4);
  for (const word of [PROMPT, ANSWER, ERROR_DETAIL]) expect(printed).not.toContain(word);
});

test("a usage of another shape, or none, logs fewer fields instead of failing", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();
  const { usage: _usage, ...withoutUsage } = settled();

  await ctx.emit("agent.settled", withoutUsage);
  // A runtime whose usage has other fields: only the numbers found are logged.
  await ctx.emit("agent.settled", { ...settled(), usage: { totalTokens: 7, cost: "unknown" } as unknown as NonNullable<AgentResult["usage"]> });

  const [none, other] = c.find("agent.settled");
  expect(none?.fields).not.toHaveProperty("totalTokens");
  expect(other?.fields).toMatchObject({ totalTokens: 7 });
  expect(other?.fields).not.toHaveProperty("cost");
});

test("a failure while logging cannot fail the code that emitted the event", async () => {
  const c = capture();
  const ctx = (await app(c.logger, c.clock)).context();
  // A payload that throws when read: the listener reports it without its content.
  const broken = { conversation, admission: { kind: "started", requestId: "r1" } } as AppEvents["agent.dispatched"];
  Object.defineProperty(broken.admission, "requestId", {
    get() {
      throw new TypeError(PROMPT);
    },
  });

  await ctx.emit("agent.dispatched", broken);

  expect(c.lines).toEqual([{ level: "warn", message: "log-events could not log an event", fields: { event: "agent.dispatched", error: "TypeError" } }]);

  // A logger that throws on every call, even the core's own "event listener failed".
  const throwing: Logger = {
    debug: () => {
      throw new Error("logger down");
    },
    info: () => {
      throw new Error("logger down");
    },
    warn: () => {
      throw new Error("logger down");
    },
    error: () => {
      throw new Error("logger down");
    },
  };
  const down = (await app(throwing, c.clock)).context();
  await expect(down.emit("agent.dispatched", { conversation, admission: { kind: "started", requestId: "r1" } })).resolves.toBeUndefined();
  await expect(down.emit("agent.started", { conversation, requestId: "r1", resumed: false })).resolves.toBeUndefined();
  await expect(down.emit("agent.settled", settled())).resolves.toBeUndefined();
  await expect(down.emit("agent.failed", failed())).resolves.toBeUndefined();
  await expect(
    down.emit("conversation.reset", { conversation, previousSessionId: "s0", newSessionId: "s1" }),
  ).resolves.toBeUndefined();
});
