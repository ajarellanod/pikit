/**
 * provider-failover's shared cooldowns (`shared.ts`), copied with the component. Apps share one owner
 * as conversations' objects do on Cloudflare: a fake mailbox (`hub`) sends every call to the owner
 * App's handler, whose `storage.sql` is SQLite in memory; a server's case is the memory mailbox, every
 * key this App. The chains' providers are fakes answering as each test scripts; no network.
 */

import { afterEach, expect, test } from "bun:test";
import type { HealthRegistry, HealthStatus } from "@pikit/contracts";
import { type ActorCallHandler, type ActorMailbox, ActorCallError, answerCall, callResult, type JsonValue } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, createProvider, type Model } from "@pikit/pi-adapter/provider";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import providerFailover from "./index.ts";
import { COOLDOWNS_KEY, SYNC } from "./shared.ts";

const MINUTE = 60_000;

/** Each model's outcomes in turn (the last again); a model with none answers. Shared by every App, as the providers' APIs are. */
const scripts = new Map<string, ({ answer: true } | { fail: string; status: number })[]>();
const asked: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  scripts.clear();
  asked.length = 0;
});

function message(model: Model<Api>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  const text = stopReason === "stop" ? `${model.provider} answers` : "";
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(errorMessage !== undefined && { errorMessage }),
    timestamp: 0,
  };
}

function fakeProvider(id: string, modelId: string): Provider {
  const stream = (model: Model<Api>, _context: unknown, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model<Api>) => unknown }) => {
    const out = createAssistantMessageEventStream();
    const name = `${model.provider}/${model.id}`;
    asked.push(name);
    const script = scripts.get(name) ?? [{ answer: true }];
    const outcome = (script.length > 1 ? script.shift() : script[0]) as { answer: true } | { fail: string; status: number };
    void (async () => {
      await options?.onResponse?.({ status: "fail" in outcome ? outcome.status : 200, headers: {} }, model);
      out.push({ type: "start", partial: message(model, "stop") });
      if ("fail" in outcome) out.push({ type: "error", reason: "error", error: message(model, "error", outcome.fail) });
      else out.push({ type: "done", reason: "stop", message: message(model, "stop") });
    })();
    return out;
  };
  return createProvider({
    id,
    auth: { apiKey: { name: `${id} key`, resolve: async () => ({ auth: { apiKey: `${id}-key` }, source: "test" }) } },
    models: [{ id: modelId, name: modelId, api: "fake", provider: id, baseUrl: "https://fake.invalid", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }],
    api: { stream, streamSimple: stream },
  });
}

const providers = defineComponent({
  name: "test-providers",
  setup(pikit) {
    for (const provider of [fakeProvider("openai", "gpt-5.5"), fakeProvider("anthropic", "claude-sonnet-4-6")]) pikit.provideKeyed("model.provider", provider.id, provider);
  },
});

/**
 * One owner for many Apps, as actors-do makes it: `component(true)` is the owner's mailbox and inbox
 * (its handlers answer every call), `component(false)` another App's (its handlers are never called).
 * `fault` makes every call refused, or never answered (until the caller's context ends); `delayMs`
 * answers each call that much later.
 */
function hub() {
  const answerers = new Map<string, ActorCallHandler>();
  let owner: AppContext | undefined;
  const state = { fault: undefined as "refuse" | "hang" | undefined, delayMs: 0, calls: [] as JsonValue[] };
  const component = (isOwner: boolean) =>
    defineComponent({
      name: "test-mailbox",
      setup(pikit) {
        pikit.provide("actor.inbox", {
          scope: "one",
          handle: () => {},
          answer: (type, handler) => void (isOwner && answerers.set(type, handler)),
          answerStream: () => {},
        });
        const mailbox: ActorMailbox = {
          send: async () => {},
          stream: async () => {
            throw new ActorCallError("no_handler", "no streams here");
          },
          async call(key, type, message, ctx) {
            state.calls.push(message);
            if (state.fault === "refuse") throw new ActorCallError("unreachable", "the owner's object failed to start");
            if (state.fault === "hang") {
              return new Promise((_resolve, reject) => ctx.abortSignal?.addEventListener("abort", () => reject(new ActorCallError("cancelled", "cancelled")), { once: true }));
            }
            if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
            const handler = answerers.get(type);
            if (handler === undefined || owner === undefined) throw new ActorCallError("no_handler", `no handler for ${type}`);
            return callResult(await answerCall(handler, key, JSON.parse(JSON.stringify(message)) as JsonValue, owner));
          },
        };
        pikit.provide("actor.mailbox", mailbox);
        return {
          start: (ctx) => void (isOwner && (owner = ctx)),
          stop: () => {
            if (!isOwner) return;
            answerers.clear();
            owner = undefined;
          },
        };
      },
    });
  return { component, state };
}

/** A `health` that keeps each reporter's last report. */
function recordingHealth() {
  const reports = new Map<string, { status: HealthStatus; reason?: string }>();
  const registry: HealthRegistry = {
    reporter: (name) => ({
      up: () => void reports.set(name, { status: "up" }),
      degraded: (reason) => void reports.set(name, { status: "degraded", reason }),
      down: (reason) => void reports.set(name, { status: "down", reason }),
    }),
    snapshot: () => ({ status: "up", components: [] }),
  };
  return { reports, component: defineComponent({ name: "test-health", setup: (pikit) => pikit.provide("health", registry) }) };
}

/** An App on `clock` with `components` (a mailbox, storage), started; `ask` asks `failover/main`. */
async function started(clock: ManualClock, components: ComponentDefinition[], logger: Logger = silentLogger) {
  let provided: Provider[] = [];
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const keyed = pikit.useKeyed("model.provider");
      return { start: () => void (provided = keyed.keys().flatMap((key) => keyed.get(key) ?? [])) };
    },
  });
  const app = await defineApp({
    components: [providers, ...components, providerFailover, reader],
    config: { "provider-failover": { chains: { main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"], other: ["anthropic/claude-sonnet-4-6"] }, refreshSeconds: 10 } },
    logger,
    clock,
  }).create();
  await app.start();
  apps.push(app);
  const models = modelsFrom(provided);
  const ask = async (chain = "main") => {
    const model = models.getModel("failover", chain);
    if (model === undefined) throw new Error(`no failover/${chain}`);
    const before = asked.length;
    const answer = await models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] });
    // Let the report of what it learnt reach the owner.
    await settle();
    return { answer, asked: asked.slice(before) };
  };
  return { app, ask };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const RATE = { fail: "429 Rate limit reached", status: 429 };

test("a failure in one App is seen by another App sharing the owner: its first request goes to the next model alone", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  const a = await started(clock, [owner.component(false)]);
  scripts.set("openai/gpt-5.5", [RATE]);
  expect((await a.ask()).asked).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);

  scripts.delete("openai/gpt-5.5");
  // The owner is slow to answer: an App's first request waits for the start's read.
  owner.state.delayMs = 50;
  const b = await started(clock, [owner.component(false)]);
  expect((await b.ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
});

test("an App already running reads the others' cooldowns at its first request once its copy is refreshSeconds old", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  const a = await started(clock, [owner.component(false)]);
  const b = await started(clock, [owner.component(false)]);
  await clock.advance(1_000);
  scripts.set("openai/gpt-5.5", [RATE]);
  await a.ask();
  scripts.delete("openai/gpt-5.5");

  // Its copy is a second old: no call to the owner.
  const calls = owner.state.calls.length;
  expect((await b.ask()).asked).toEqual(["openai/gpt-5.5"]);
  expect(owner.state.calls.length).toBe(calls);

  // Ten seconds old: a request (of any chain) starts a read, and the next ones have it.
  await clock.advance(10_000);
  await b.ask("other");
  expect(owner.state.calls.length).toBe(calls + 1);
  expect((await b.ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
});

test("a restart over the same storage keeps a cooldown (a server: the memory mailbox, the App its own owner)", async () => {
  const clock = createManualClock();
  const storage = sqliteStorage();
  const first = await started(clock, [storage, createMemoryMailbox()]);
  scripts.set("openai/gpt-5.5", [RATE]);
  await first.ask();
  await first.app.stop();
  scripts.delete("openai/gpt-5.5");

  const again = await started(clock, [storage, createMemoryMailbox()]);
  expect((await again.ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
  // Without the mailbox, nothing is shared: memory only, as before.
  const alone = await started(clock, [storage]);
  expect((await alone.ask()).asked).toEqual(["openai/gpt-5.5"]);
});

test("an answer clears the cooldown everywhere", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  const a = await started(clock, [owner.component(false)]);
  scripts.set("openai/gpt-5.5", [RATE, { answer: true }]);
  scripts.set("anthropic/claude-sonnet-4-6", [{ fail: "503 Service Unavailable", status: 503 }, { answer: true }]);
  expect((await a.ask()).answer.stopReason).toBe("error");
  await clock.advance(1_000);
  // Both cooling: tried anyway, in chain order, and OpenAI answers.
  expect((await a.ask()).asked).toEqual(["openai/gpt-5.5"]);

  // Anthropic's 30 seconds are over; OpenAI's 15 minutes would not be, but its answer cleared them.
  await clock.advance(31_000);
  const b = await started(clock, [owner.component(false)]);
  expect((await b.ask()).asked).toEqual(["openai/gpt-5.5"]);
});

test("a cooldown that ended elsewhere is over here too", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  const a = await started(clock, [owner.component(false)]);
  scripts.set("openai/gpt-5.5", [RATE]);
  await a.ask();
  scripts.delete("openai/gpt-5.5");

  await clock.advance(15 * MINUTE - 1);
  expect((await (await started(clock, [owner.component(false)])).ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
  await clock.advance(2);
  expect((await (await started(clock, [owner.component(false)])).ask()).asked).toEqual(["openai/gpt-5.5"]);
});

test("an owner that fails never fails a request: the App goes on with its own copy, logs once, and reports what it learnt when the owner is back", async () => {
  const clock = createManualClock();
  const owner = hub();
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
  await started(clock, [sqliteStorage(), owner.component(true)]);
  owner.state.fault = "refuse";
  const a = await started(clock, [owner.component(false)], logger);
  scripts.set("openai/gpt-5.5", [RATE]);
  expect((await a.ask()).answer.provider).toBe("anthropic");
  scripts.delete("openai/gpt-5.5");
  expect((await a.ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
  expect(warnings.filter((warning) => warning.includes("shared"))).toEqual(["provider-failover: the shared cooldowns could not be synced; going on with this App's own"]);

  // An owner that never answers: the first requests wait for it a second at most.
  owner.state.fault = "hang";
  const b = await started(clock, [owner.component(false)]);
  const startedAt = Date.now();
  expect((await b.ask()).asked).toEqual(["openai/gpt-5.5"]);
  expect(Date.now() - startedAt).toBeLessThan(3_000);

  // Back: A's next read sends the failure the owner never took, and a new App sees it.
  owner.state.fault = undefined;
  await clock.advance(10_000);
  await a.ask();
  await settle();
  expect((await (await started(clock, [owner.component(false)])).ask()).asked).toEqual(["anthropic/claude-sonnet-4-6"]);
});

test("with health, an App reports what the others learnt", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  const a = await started(clock, [owner.component(false)]);
  scripts.set("openai/gpt-5.5", [RATE]);
  await a.ask();

  const health = recordingHealth();
  await started(clock, [owner.component(false), health.component]);
  await settle();
  expect(health.reports.get("provider-failover:main")).toEqual({
    status: "degraded",
    reason: `openai/gpt-5.5 rate, until ${new Date(clock.now() + 15 * MINUTE).toISOString()}; answering with anthropic/claude-sonnet-4-6`,
  });
});

test("the owner keeps the newest entry of each key: a report sent again, or one older than an answer, changes nothing; another key is refused", async () => {
  const clock = createManualClock();
  const owner = hub();
  await started(clock, [sqliteStorage(), owner.component(true)]);
  let mailbox: ActorMailbox | undefined;
  const reader = defineComponent({
    name: "test-reader",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const { app } = await started(clock, [owner.component(false), reader]);
  const sync = (entries: JsonValue[], key = COOLDOWNS_KEY) => (mailbox as ActorMailbox).call(key, SYNC, { entries }, app.context());
  const at = clock.now();
  const failed = { key: "model:openai/gpt-5.5", kind: "rate", until: at + 2_000, at: at + 1_000 };
  const cleared = { key: "model:openai/gpt-5.5", until: 0, at: at + 1_500 };

  expect(await sync([failed, failed])).toEqual({ entries: [failed] });
  expect(await sync([cleared])).toEqual({ entries: [cleared] });
  expect(await sync([failed])).toEqual({ entries: [cleared] });
  // At the same time, an answer wins: every order ends the same.
  expect(await sync([{ ...failed, at: at + 1_500 }])).toEqual({ entries: [cleared] });
  const refused = { key: "provider:openai", kind: "auth", until: at + 5_000, at: at + 2_000 };
  const answered = { key: "provider:openai", until: 0, at: at + 2_000 };
  expect((await sync([refused, answered])) as unknown).toEqual({ entries: [cleared, answered] });

  expect(await sync([], "provider-failover:elsewhere").catch((error: ActorCallError) => error.code)).toBe("invalid");
  expect(await sync([{ key: "model:openai/gpt-5.5", kind: "bored", until: 1, at: 1 }]).catch((error: ActorCallError) => error.code)).toBe("invalid");
});
