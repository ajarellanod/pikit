/**
 * provider-failover's tests. They are copied with the component and keep running in your project.
 * The chains' providers are fakes whose every request answers as the test scripts it (an answer, a
 * failure before or after its text, an HTTP status); no network, no credential.
 */

import { afterEach, expect, test } from "bun:test";
import type { HealthRegistry, HealthStatus } from "@pikit/contracts";
import { type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, createProvider, type Model } from "@pikit/pi-adapter/provider";
import providerFailover from "./index.ts";
import { classify } from "./failover.ts";

/** How one request to a fake model goes. */
type Outcome =
  | { answer: string }
  | { fail: string; status?: number; afterText?: string; reason?: "error" | "aborted" };

const MINUTE = 60_000;

/** What each fake model answers, in turn (the last one again when the script runs out), and what it was asked. */
const scripts = new Map<string, Outcome[]>();
const asked: string[] = [];
afterEach(() => {
  scripts.clear();
  asked.length = 0;
});

function message(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
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

/** A provider `id` with `models`, each answering as `scripts` says; `configured: false` has no credentials. */
function fakeProvider(id: string, models: { id: string; contextWindow?: number; image?: boolean; reasoning?: boolean }[], configured = true): Provider {
  const stream = (model: Model<Api>, _context: unknown, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model<Api>) => unknown }) => {
    const out = createAssistantMessageEventStream();
    const name = `${model.provider}/${model.id}`;
    asked.push(name);
    const script = scripts.get(name) ?? [{ answer: `${name} answers` }];
    const outcome = (script.length > 1 ? script.shift() : script[0]) as Outcome;
    void (async () => {
      await options?.onResponse?.({ status: "fail" in outcome && outcome.status !== undefined ? outcome.status : 200, headers: {} }, model);
      out.push({ type: "start", partial: message(model, "", "stop") });
      const text = "answer" in outcome ? outcome.answer : (outcome.afterText ?? "");
      if (text !== "") {
        out.push({ type: "text_start", contentIndex: 0, partial: message(model, "", "stop") });
        out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message(model, text, "stop") });
        out.push({ type: "text_end", contentIndex: 0, content: text, partial: message(model, text, "stop") });
      }
      if ("answer" in outcome) out.push({ type: "done", reason: "stop", message: message(model, text, "stop") });
      else out.push({ type: "error", reason: outcome.reason ?? "error", error: message(model, text, outcome.reason ?? "error", outcome.fail) });
    })();
    return out;
  };
  return createProvider({
    id,
    auth: { apiKey: { name: `${id} key`, resolve: async () => (configured ? { auth: { apiKey: `${id}-key` }, source: "test" } : undefined) } },
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      api: "fake",
      provider: id,
      baseUrl: "https://fake.invalid",
      reasoning: m.reasoning ?? false,
      input: m.image === false ? ["text"] : ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 200_000,
      maxTokens: 32_000,
    })),
    api: { stream, streamSimple: stream },
  });
}

const openai = fakeProvider("openai", [{ id: "gpt-5.5", reasoning: true }, { id: "gpt-5.4-mini" }]);
const anthropic = fakeProvider("anthropic", [{ id: "claude-sonnet-4-6", contextWindow: 100_000, image: false }]);

function providing(...providers: Provider[]): ComponentDefinition {
  return defineComponent({
    name: "test-providers",
    setup: (pikit) => {
      for (const provider of providers) pikit.provideKeyed("model.provider", provider.id, provider);
    },
  });
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
  const component = defineComponent({ name: "test-health", setup: (pikit) => pikit.provide("health", registry) });
  return { reports, component };
}

const CHAIN = ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"];

/** The App, started, with what a runtime would have: every model.provider in one Models. */
async function started(chains: Record<string, string[]> = { main: CHAIN }, extra: ComponentDefinition[] = [], providers: Provider[] = [openai, anthropic]) {
  const clock = createManualClock();
  let provided: Provider[] = [];
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const keyed = pikit.useKeyed("model.provider");
      return { start: () => void (provided = keyed.keys().flatMap((key) => keyed.get(key) ?? [])) };
    },
  });
  const app = await defineApp({
    components: [providing(...providers), providerFailover, ...extra, reader],
    config: { "provider-failover": { chains, cooldownSeconds: { rate: 15 * 60, auth: 15 * 60, unavailable: 60 * 60, transient: 30 } } },
    logger: silentLogger,
    clock,
  }).create();
  await app.start();
  const models = modelsFrom(provided);
  const ask = async (chain = "main") => {
    const model = models.getModel("failover", chain);
    if (model === undefined) throw new Error(`no failover/${chain}`);
    return models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] });
  };
  return { app, clock, models, ask };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providing(openai, anthropic), providerFailover], config: { "provider-failover": { chains: { main: CHAIN } } }, logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "provider-failover")).toEqual({
    name: "provider-failover",
    provides: ["model.provider"],
    // A keyed use is optional: a chain's providers are checked at start.
    requires: [],
    optional: ["model.provider", "model.credentials", "secrets", "health"],
  });
  expect(app.describe().capabilities["model.provider"]?.keys).toEqual({ openai: "test-providers", anthropic: "test-providers", failover: "provider-failover" });
});

test("a chain is a model failover/<chain>: what all its models take, the smallest window, reasoning when one reasons", async () => {
  const { app, models } = await started({ main: CHAIN, mini: ["openai/gpt-5.4-mini"] });
  try {
    const main = models.getModel("failover", "main");
    expect(main).toMatchObject({ provider: "failover", id: "main", contextWindow: 100_000, maxTokens: 32_000, input: ["text"], reasoning: true });
    expect(main?.name).toBe("Failover main: openai/gpt-5.5 → anthropic/claude-sonnet-4-6");
    expect(models.getModel("failover", "mini")).toMatchObject({ contextWindow: 200_000, input: ["text", "image"], reasoning: false });
    // Configured when one of its providers is (runtime-pi checks it at start).
    expect(await models.checkAuth("failover")).toBeDefined();
  } finally {
    await app.stop();
  }
});

test("it refuses to start on a chain that names a model no provider has, or another chain", async () => {
  const create = (chains: Record<string, string[]>) =>
    defineApp({ components: [providing(openai), providerFailover], config: { "provider-failover": { chains } }, logger: silentLogger }).create();

  const refusal = async (chains: Record<string, string[]>) => {
    const error = await (await create(chains)).start().then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toContain('"provider-failover" failed to start');
    return String(error?.cause);
  };

  expect(await refusal({ main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"] })).toContain(
    'provider-failover: chain "main" names "anthropic/claude-sonnet-4-6", which no model.provider provides (installed: openai)',
  );
  expect(await refusal({ main: ["openai/gpt-5.5"], outer: ["failover/main"] })).toContain('chain "outer" names "failover/main", another chain');
});

test("a model that fails before it shows anything: the same request goes to the next, and the failed one cools down", async () => {
  const { app, clock, ask } = await started();
  try {
    scripts.set("openai/gpt-5.5", [{ fail: "429 Rate limit reached", status: 429 }, { answer: "openai is back" }]);

    const first = await ask();
    expect(first.stopReason).toBe("stop");
    expect(first.content).toEqual([{ type: "text", text: "anthropic/claude-sonnet-4-6 answers" }]);
    // The answer is the model's that gave it: its usage is priced by it.
    expect([first.provider, first.model]).toEqual(["anthropic", "claude-sonnet-4-6"]);
    expect(asked).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);

    // Cooling down: the next request starts on the next model.
    await ask();
    expect(asked.slice(2)).toEqual(["anthropic/claude-sonnet-4-6"]);

    // After the cooldown, the first model again.
    await clock.advance(15 * MINUTE + 1);
    expect((await ask()).content).toEqual([{ type: "text", text: "openai is back" }]);
  } finally {
    await app.stop();
  }
});

test("a failure after the answer has started is the answer's: never replayed elsewhere, but the retry starts on the next model", async () => {
  const { app, ask } = await started();
  try {
    scripts.set("openai/gpt-5.5", [{ fail: "socket hang up", afterText: "Half an ans" }]);

    const cut = await ask();
    expect(cut.stopReason).toBe("error");
    expect(cut.errorMessage).toBe("socket hang up");
    expect(asked).toEqual(["openai/gpt-5.5"]);

    // pi-durable's retry: the cut model cools down (transient), so another answers.
    expect((await ask()).provider).toBe("anthropic");
  } finally {
    await app.stop();
  }
});

test("what another model would fail the same way is not moved: a bad request, an overflow, an abort", async () => {
  const { app, ask } = await started();
  try {
    for (const outcome of [
      { fail: "400 Invalid schema for function 'read'", status: 400 },
      { fail: "prompt is too long: 213000 tokens > 200000 maximum", status: 400 },
      // An overflow pi-ai would otherwise retry ("Provider returned error"): pi-durable compacts instead.
      { fail: "Provider returned error: This endpoint's maximum context length is 131072 tokens" },
      { fail: "Request was aborted", reason: "aborted" as const },
    ]) {
      asked.length = 0;
      scripts.set("openai/gpt-5.5", [outcome]);
      const failed = await ask();
      expect(failed.errorMessage).toBe(outcome.fail);
      expect(asked).toEqual(["openai/gpt-5.5"]);
    }
  } finally {
    await app.stop();
  }
});

test("when every model fails, the last failure is the answer, saying what was tried; cooling models are still tried last", async () => {
  const { app, ask } = await started();
  try {
    scripts.set("openai/gpt-5.5", [{ fail: "You exceeded your current quota (insufficient_quota)", status: 429 }]);
    scripts.set("anthropic/claude-sonnet-4-6", [{ fail: "503 Service Unavailable", status: 503 }]);

    const failed = await ask();
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toBe('503 Service Unavailable (provider-failover "main" tried openai/gpt-5.5: rate, anthropic/claude-sonnet-4-6: transient)');

    // Both cooling down: tried anyway, in chain order, rather than refusing.
    asked.length = 0;
    scripts.set("anthropic/claude-sonnet-4-6", [{ answer: "anthropic is back" }]);
    expect((await ask()).content).toEqual([{ type: "text", text: "anthropic is back" }]);
    expect(asked).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  } finally {
    await app.stop();
  }
});

test("refused credentials cool the whole provider: its other models are skipped too", async () => {
  const { app, ask } = await started({ main: CHAIN, mini: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"] });
  try {
    scripts.set("openai/gpt-5.5", [{ fail: "401 Incorrect API key provided", status: 401 }]);

    await ask("main");
    asked.length = 0;
    await ask("mini");
    expect(asked).toEqual(["anthropic/claude-sonnet-4-6"]);
  } finally {
    await app.stop();
  }
});

test("a provider with no credentials fails as refused credentials, and the chain goes on", async () => {
  const unconfigured = fakeProvider("openai", [{ id: "gpt-5.5" }], false);
  const { app, ask } = await started({ main: CHAIN }, [], [unconfigured, anthropic]);
  try {
    expect((await ask()).provider).toBe("anthropic");
    expect(asked).toEqual(["anthropic/claude-sonnet-4-6"]);
  } finally {
    await app.stop();
  }
});

test("with health, each chain reports: degraded while a model cools down, saying why and until when; down while all do; up once answered", async () => {
  const health = recordingHealth();
  const { app, clock, ask } = await started({ main: CHAIN }, [health.component]);
  try {
    expect(health.reports.get("provider-failover:main")).toEqual({ status: "up" });

    scripts.set("openai/gpt-5.5", [{ fail: "401 invalid api key", status: 401 }]);
    await ask();
    const until = new Date(clock.now() + 15 * MINUTE).toISOString();
    expect(health.reports.get("provider-failover:main")).toEqual({
      status: "degraded",
      reason: `openai/gpt-5.5 credentials refused, log in to openai again, until ${until}; answering with anthropic/claude-sonnet-4-6`,
    });

    scripts.set("anthropic/claude-sonnet-4-6", [{ fail: "529 overloaded_error: Overloaded", status: 529 }]);
    await ask();
    expect(health.reports.get("provider-failover:main")?.status).toBe("down");

    scripts.set("openai/gpt-5.5", [{ answer: "logged in again" }]);
    scripts.set("anthropic/claude-sonnet-4-6", [{ answer: "back" }]);
    await clock.advance(15 * MINUTE + 1);
    await ask();
    expect(health.reports.get("provider-failover:main")).toEqual({ status: "up" });
  } finally {
    await app.stop();
  }
});

test("classify: what moves a request, and why", () => {
  const failed = (errorMessage: string): AssistantMessage => ({ ...message({ api: "fake", provider: "p", id: "m" } as Model<Api>, "", "error"), errorMessage });

  expect(classify(429, failed("Too Many Requests"), 100_000)).toBe("rate");
  expect(classify(undefined, failed("subscription_sharing_usage_limit_exceeded"), 100_000)).toBe("rate");
  expect(classify(undefined, failed("Request too large for gpt-5.5 on tokens per min (TPM): Limit 30000"), 100_000)).toBe("rate");
  expect(classify(undefined, failed("OAuth refresh failed for openai"), 100_000)).toBe("auth");
  expect(classify(undefined, failed("Provider is not configured: openai"), 100_000)).toBe("auth");
  expect(classify(404, failed("The model `gpt-9` does not exist"), 100_000)).toBe("unavailable");
  expect(classify(502, failed("Bad gateway"), 100_000)).toBe("transient");
  expect(classify(undefined, failed("fetch failed"), 100_000)).toBe("transient");
  expect(classify(413, failed("413 request_too_large"), 100_000)).toBeUndefined();
  expect(classify(400, failed("Invalid value for 'tools'"), 100_000)).toBeUndefined();
});
