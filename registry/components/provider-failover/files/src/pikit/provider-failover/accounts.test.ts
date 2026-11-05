/**
 * provider-failover's accounts: more accounts of an installed provider, each a model provider of its
 * own. They are copied with the component and keep running in your project. The base providers are
 * fakes whose API records what it was sent (the model's provider, the key, the transcript's answers)
 * and answers as the test scripts it, per key; the credentials are in a store in memory, the
 * variables in a map. No network, no real credential.
 */

import { afterEach, expect, test } from "bun:test";
import type { SecretStore } from "@pikit/contracts";
import { type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { type Credential, type CredentialStore, type Models, modelsFrom, type Provider } from "@pikit/pi-adapter";
import { type Api, type AssistantMessage, type AssistantMessageEvent, type AuthContext, createAssistantMessageEventStream, createProvider, type Model } from "@pikit/pi-adapter/provider";
import providerFailover from "./index.ts";

const MINUTE = 60_000;
/** The variable the fake base providers read their key from (not a real provider's: the machine's environment never answers). */
const KEY = "FAKE_ANTHROPIC_KEY";

/** What the base API was sent, per request. */
const seen: { provider: string; model: string; apiKey: string | undefined; transcript: string[] }[] = [];
/** Per key, how its requests fail, in turn (the last again when the script runs out); a key without one answers. */
const scripts = new Map<string, { fail: string; status: number }[]>();
afterEach(() => {
  seen.length = 0;
  scripts.clear();
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

/** A provider `id` whose key is a stored one, else `KEY`'s; its OAuth login gives the token `<id>-login`. */
function fakeBase(id: string, models: string[]): Provider {
  type Options = { apiKey?: string; onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model<Api>) => unknown };
  const stream = (model: Model<Api>, context: { messages: { role: string; provider?: string }[] }, options?: Options) => {
    const out = createAssistantMessageEventStream();
    seen.push({ provider: model.provider, model: model.id, apiKey: options?.apiKey, transcript: context.messages.flatMap((m) => (m.role === "assistant" ? [m.provider ?? ""] : [])) });
    const script = scripts.get(options?.apiKey ?? "");
    const failing = script === undefined ? undefined : script.length > 1 ? script.shift() : script[0];
    void (async () => {
      await options?.onResponse?.({ status: failing?.status ?? 200, headers: {} }, model);
      const partial = message(model, "", "stop");
      out.push({ type: "start", partial });
      if (failing !== undefined) return out.push({ type: "error", reason: "error", error: message(model, "", "error", failing.fail) });
      const text = `answered with ${options?.apiKey}`;
      partial.content = [{ type: "text", text }];
      out.push({ type: "text_start", contentIndex: 0, partial });
      out.push({ type: "text_end", contentIndex: 0, content: text, partial });
      out.push({ type: "done", reason: "stop", message: message(model, text, "stop") });
    })();
    return out;
  };
  return createProvider({
    id,
    name: `Fake ${id}`,
    auth: {
      apiKey: {
        name: `${id} key`,
        // A check without a request (pi-ai's `envApiKeyAuth` has one): `checkAuth` and `pikit configure` ask it.
        check: async ({ ctx, credential }) => (credential?.key !== undefined ? { type: "api_key", source: "stored credential" } : (await ctx.env(KEY)) === undefined ? undefined : { type: "api_key", source: KEY }),
        resolve: async ({ ctx, credential }) => {
          if (credential?.key !== undefined) return { auth: { apiKey: credential.key }, source: "stored credential" };
          const key = await ctx.env(KEY);
          return key === undefined ? undefined : { auth: { apiKey: key }, source: KEY };
        },
      },
      oauth: {
        name: `${id} subscription`,
        login: async () => ({ type: "oauth", access: `${id}-login`, refresh: "refresh", expires: Date.now() + 60 * MINUTE }),
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: models.map((model) => ({
      id: model,
      name: model,
      api: "fake",
      provider: id,
      baseUrl: "https://fake.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    })),
    api: { stream, streamSimple: stream },
  });
}

/** pi-ai's `CredentialStore` in memory: what each provider id holds. */
function memoryStore(initial: Record<string, Credential> = {}) {
  const stored = new Map(Object.entries(initial));
  const store: CredentialStore = {
    read: async (providerId) => stored.get(providerId),
    list: async () => [...stored].map(([providerId, credential]) => ({ providerId, type: credential.type })),
    async modify(providerId, fn) {
      const next = await fn(stored.get(providerId));
      if (next !== undefined) stored.set(providerId, next);
      return stored.get(providerId);
    },
    delete: async (providerId) => void stored.delete(providerId),
  };
  return { stored, store };
}

const key = (value: string): Credential => ({ type: "api_key", key: value });
const variables = (values: Record<string, string>): AuthContext => ({ env: async (name) => values[name], fileExists: async () => false });

const anthropic = fakeBase("anthropic", ["x", "z"]);
const openrouter = fakeBase("openrouter", ["y"]);

interface Setup {
  accounts?: Record<string, { provider: string; env?: Record<string, string> }>;
  chains?: Record<string, string[]>;
  credentials?: Record<string, Credential>;
  secrets?: Record<string, string>;
  /** The environment: tests have no process environment of their own, so a chain of these reads none. */
  env?: Record<string, string>;
}

/** The App, started, and what a runtime would have: every model.provider in one Models, with the App's credentials and secrets. */
async function started({ accounts = { "anthropic-2": { provider: "anthropic" } }, chains = {}, credentials = {}, secrets, env = {} }: Setup = {}) {
  const store = memoryStore(credentials);
  let provided: Provider[] = [];
  const components: ComponentDefinition[] = [
    defineComponent({
      name: "test-providers",
      setup(pikit) {
        for (const provider of [anthropic, openrouter]) pikit.provideKeyed("model.provider", provider.id, provider);
        pikit.provide("model.credentials", store.store);
        if (secrets !== undefined) pikit.provide("secrets", { get: async (name: string) => secrets[name] } as SecretStore);
      },
    }),
    providerFailover,
    defineComponent({
      name: "provider-reader",
      setup(pikit) {
        const keyed = pikit.useKeyed("model.provider");
        return { start: () => void (provided = keyed.keys().flatMap((k) => keyed.get(k) ?? [])) };
      },
    }),
  ];
  const clock = createManualClock();
  const app = await defineApp({
    components,
    config: { "provider-failover": { chains, accounts, cooldownSeconds: { rate: 15 * 60, auth: 15 * 60, unavailable: 60 * 60, transient: 30 } } },
    logger: silentLogger,
    clock,
  }).create();
  await app.start();
  const models = modelsFrom(provided, { credentials: store.store, authContext: variables(env), ...(secrets !== undefined && { secrets: { get: async (name: string) => secrets[name] } as SecretStore }) });
  return { app, clock, models, provided, store: store.store, stored: store.stored };
}

async function ask(models: Models, provider: string, id: string, transcript: AssistantMessage[] = []) {
  const model = models.getModel(provider, id);
  if (model === undefined) throw new Error(`no ${provider}/${id}`);
  const events: AssistantMessageEvent[] = [];
  const stream = models.streamSimple(model, { messages: [...transcript, { role: "user", content: "hello", timestamp: 0 }] });
  for await (const event of stream) events.push(event);
  return { answer: await stream.result(), events };
}

test("an account is a model.provider of provider-failover's, under its own id, with the models of the provider it is an account of", async () => {
  const { app, models, provided } = await started({ accounts: { "anthropic-2": { provider: "anthropic" }, "openrouter-2": { provider: "openrouter" } } });
  try {
    expect(app.describe().capabilities["model.provider"]?.keys).toEqual({
      anthropic: "test-providers",
      openrouter: "test-providers",
      failover: "provider-failover",
      "anthropic-2": "provider-failover",
      "openrouter-2": "provider-failover",
    });
    const account = provided.find((provider) => provider.id === "anthropic-2");
    expect(account?.name).toBe("Fake anthropic (anthropic-2)");
    // Its logins are the provider's: `pikit configure --login anthropic-2` offers one (provider.auth.oauth).
    expect(account?.auth.oauth).toBe(anthropic.auth.oauth);
    expect(models.getModels("anthropic-2").map((model) => `${model.provider}/${model.id}`)).toEqual(["anthropic-2/x", "anthropic-2/z"]);
    expect(models.getModel("anthropic-2", "x")).toMatchObject({ api: "fake", contextWindow: 100_000, cost: { input: 1, output: 2 } });
  } finally {
    await app.stop();
  }
});

test("an account answers with its own credential, never the base account's; the answer is the account's", async () => {
  const { app, models } = await started({ accounts: { "anthropic-2": { provider: "anthropic" }, "anthropic-3": { provider: "anthropic" } }, credentials: { anthropic: key("key-1"), "anthropic-2": key("key-2") }, env: { [KEY]: "env-key" } });
  try {
    const { answer, events } = await ask(models, "anthropic-2", "x");
    expect(answer).toMatchObject({ stopReason: "stop", provider: "anthropic-2", model: "x", content: [{ type: "text", text: "answered with key-2" }] });
    // Every event's message is the account's, the live partial included.
    expect(new Set(events.map((event) => (event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial).provider))).toEqual(new Set(["anthropic-2"]));
    // The base provider's API is sent the request as its own (pi-ai's APIs tell a ChatGPT login by it).
    expect(seen).toEqual([{ provider: "anthropic", model: "x", apiKey: "key-2", transcript: [] }]);

    expect((await ask(models, "anthropic", "x")).answer.content).toEqual([{ type: "text", text: "answered with key-1" }]);
    // An account with nothing stored and no variable of its own is not configured: the base's environment is not its.
    expect(await models.checkAuth("anthropic")).toBeDefined();
    expect(await models.checkAuth("anthropic-3")).toBeUndefined();
  } finally {
    await app.stop();
  }
});

test("a login with an account is stored under its id, never over the base account's credential", async () => {
  const { app, provided, models, store, stored } = await started({ credentials: { anthropic: key("key-1") } });
  try {
    // As `pikit configure --login anthropic-2` does (credentials.ts): a Models of that one provider.
    const account = provided.find((provider) => provider.id === "anthropic-2") as Provider;
    await modelsFrom([account], { credentials: store }).login("anthropic-2", "oauth", { prompt: async () => "", notify: () => {} });

    expect(stored.get("anthropic-2")).toMatchObject({ type: "oauth", access: "anthropic-login" });
    expect(stored.get("anthropic")).toEqual(key("key-1"));
    expect((await ask(models, "anthropic-2", "x")).answer.content).toEqual([{ type: "text", text: "answered with anthropic-login" }]);
    expect((await ask(models, "anthropic", "x")).answer.content).toEqual([{ type: "text", text: "answered with key-1" }]);
  } finally {
    await app.stop();
  }
});

test("an account's key is read from the variables its env maps (secrets first), never from the base account's", async () => {
  const { app, models } = await started({
    accounts: {
      // A key of its own, in the environment.
      "anthropic-2": { provider: "anthropic", env: { [KEY]: `${KEY}_2` } },
      // A key of its own, in `secrets`.
      "anthropic-3": { provider: "anthropic", env: { [KEY]: `${KEY}_3` } },
      // The base account's own variable: the base holds a subscription's login, the account its API key.
      "anthropic-key": { provider: "anthropic", env: { [KEY]: KEY } },
    },
    credentials: { anthropic: { type: "oauth", access: "subscription-token", refresh: "refresh", expires: Date.now() + 60 * MINUTE } },
    env: { [KEY]: "env-key", [`${KEY}_2`]: "second-env-key" },
    secrets: { [`${KEY}_3`]: "third-secret-key" },
  });
  try {
    const text = async (provider: string) => (await ask(models, provider, "x")).answer.content;
    expect(await text("anthropic")).toEqual([{ type: "text", text: "answered with subscription-token" }]);
    expect(await text("anthropic-2")).toEqual([{ type: "text", text: "answered with second-env-key" }]);
    expect(await text("anthropic-3")).toEqual([{ type: "text", text: "answered with third-secret-key" }]);
    expect(await text("anthropic-key")).toEqual([{ type: "text", text: "answered with env-key" }]);
    // What it read, for status: the account's variable.
    expect((await models.getAuth("anthropic-2"))?.source).toBe(`${KEY}_2`);
    expect(await models.checkAuth("anthropic-3")).toEqual({ type: "api_key", source: `${KEY}_3` });
  } finally {
    await app.stop();
  }
});

test("the base provider is sent the account's transcript as its own, and the base account's answers as another provider's", async () => {
  const { app, models } = await started({ credentials: { "anthropic-2": key("key-2") } });
  try {
    const earlier = (provider: string) => ({ ...message({ api: "fake", provider, id: "x" } as Model<Api>, `by ${provider}`, "stop") });
    await ask(models, "anthropic-2", "x", [earlier("anthropic-2"), earlier("anthropic"), earlier("openrouter")]);
    expect(seen[0]?.transcript).toEqual(["anthropic", "anthropic-2", "openrouter"]);
  } finally {
    await app.stop();
  }
});

const ACCOUNTS_CREDENTIALS = { anthropic: key("key-1"), "anthropic-2": key("key-2"), openrouter: key("key-or") };

test("a chain moves from a rate-limited account to the next account, then to another provider", async () => {
  const { app, clock, models } = await started({ chains: { main: ["anthropic/x", "anthropic-2/x", "openrouter/y"] }, credentials: ACCOUNTS_CREDENTIALS });
  try {
    scripts.set("key-1", [{ fail: "429 rate_limit_error: This request would exceed your account's rate limit", status: 429 }]);
    const first = await ask(models, "failover", "main");
    expect(first.answer).toMatchObject({ provider: "anthropic-2", content: [{ type: "text", text: "answered with key-2" }] });
    expect(seen.map((request) => request.apiKey)).toEqual(["key-1", "key-2"]);

    // The first account cools down: the next request starts on the second.
    seen.length = 0;
    await ask(models, "failover", "main");
    expect(seen.map((request) => request.apiKey)).toEqual(["key-2"]);

    // The second account's limit too: the chain's other provider answers.
    seen.length = 0;
    scripts.set("key-2", [{ fail: "429 usage limit reached", status: 429 }]);
    expect((await ask(models, "failover", "main")).answer.provider).toBe("openrouter");
    expect(seen.map((request) => request.apiKey)).toEqual(["key-2", "key-or"]);

    // The first account's cooldown ends: it answers again.
    seen.length = 0;
    scripts.clear();
    await clock.advance(15 * MINUTE + 1);
    expect((await ask(models, "failover", "main")).answer.provider).toBe("anthropic");
  } finally {
    await app.stop();
  }
});

test("refused credentials of one account cool that account, every model of it, and not the other account", async () => {
  const { app, models } = await started({
    chains: { main: ["anthropic/x", "anthropic-2/x"], other: ["anthropic/z", "anthropic-2/z"], second: ["anthropic-2/z", "openrouter/y"] },
    credentials: ACCOUNTS_CREDENTIALS,
  });
  try {
    scripts.set("key-1", [{ fail: "401 invalid x-api-key", status: 401 }]);
    expect((await ask(models, "failover", "main")).answer.provider).toBe("anthropic-2");

    // The first account's other model is skipped too: its credentials are refused.
    seen.length = 0;
    await ask(models, "failover", "other");
    expect(seen.map((request) => `${request.apiKey} ${request.model}`)).toEqual(["key-2 z"]);

    // The second account is not cooling: it answers first where it is first.
    seen.length = 0;
    expect((await ask(models, "failover", "second")).answer.provider).toBe("anthropic-2");
    expect(seen.map((request) => request.apiKey)).toEqual(["key-2"]);
  } finally {
    await app.stop();
  }
});

test("it refuses an account that is not a provider id, takes the chains' id or an installed provider's, or is an account of a provider not installed", async () => {
  const refusal = async (accounts: Record<string, { provider: string }>) => {
    const created = await defineApp({
      components: [defineComponent({ name: "test-providers", setup: (pikit) => pikit.provideKeyed("model.provider", "anthropic", anthropic) }), providerFailover],
      config: { "provider-failover": { accounts } },
      logger: silentLogger,
    })
      .create()
      .then(
        (app) => app,
        (error: unknown) => error as Error,
      );
    if (created instanceof Error) return `${created.message} ${String(created.cause ?? "")}`;
    const error = await created.start().then(() => undefined, (e: unknown) => e as Error);
    await created.stop().catch(() => {});
    return error === undefined ? "started" : `${error.message} ${String(error.cause ?? "")}`;
  };

  expect(await refusal({ "Anthropic 2": { provider: "anthropic" } })).toContain('provider-failover: account "Anthropic 2" is not a provider id');
  expect(await refusal({ failover: { provider: "anthropic" } })).toContain('provider-failover: account "failover" takes the chains\' id');
  expect(await refusal({ anthropic: { provider: "anthropic" } })).toContain('key "anthropic" is provided by both "test-providers" and "provider-failover"');
  expect(await refusal({ "mistral-2": { provider: "mistral" } })).toContain('provider-failover: account "mistral-2" is an account of "mistral", which no model.provider provides (installed: anthropic)');
  expect(await refusal({ "anthropic-2": { provider: "anthropic" }, "anthropic-3": { provider: "anthropic-2" } })).toContain('account "anthropic-3" is an account of "anthropic-2", which is another account');
  expect(await refusal({ "failover-2": { provider: "failover" } })).toContain('account "failover-2" is an account of "failover", which is the chains');
  expect(await refusal({ "anthropic-2": { provider: "anthropic" } })).toBe("started");
});
