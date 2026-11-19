/**
 * credentials-do's tests. They are copied with the component and keep running in your project.
 *
 * Cloudflare's objects are a double here (`Objects`): each App is one object, and a call reaches the
 * App of its key, as actors-do's RPC does; the owner object's App and each conversation's have their
 * own `storage.sql`. Anthropic's OAuth token endpoint is a local `Bun.serve` fake: pi-ai's own
 * Anthropic flow refreshes against it (`globalThis.fetch` sends it there). Nothing reaches the network.
 */

import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorCallHandler, type ActorMailbox, type AdminAuth, answerCall, callResult, type HttpRoute, type JsonValue } from "@pikit/contracts";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { type Credential, type CredentialStore, modelsFrom } from "@pikit/pi-adapter";
import { anthropicProvider } from "@pikit/pi-adapter/providers/anthropic";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createCredentialStoreConformance } from "@pikit/pi-adapter/testing/neutral";
import { CALL, CREDENTIALS_KEY } from "./calls.ts";
import credentialsDo, { worker } from "./index.ts";
import { LEASE_MS } from "./owner.ts";
import { OAUTH_REFRESH_MARGIN_MS } from "./remote.ts";

const ACCESS = "sk-ant-oat-secret-access-1";
const REFRESH = "sk-ant-ort-secret-refresh-1";
const SECRETS = [ACCESS, REFRESH, "sk-ant-oat-new-access", "sk-ant-ort-new-refresh", "sk-ant-api-uploaded-key"];

/** Anthropic's OAuth token endpoint: answers each refresh after `delayMs`, or refuses with `refuse`. */
const token = {
  requests: [] as Record<string, unknown>[],
  delayMs: 0,
  refuse: undefined as number | undefined,
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
};
const realFetch = globalThis.fetch;

beforeAll(() => {
  token.server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/oauth/token") return new Response("not found", { status: 404 });
      token.requests.push((await request.json()) as Record<string, unknown>);
      if (token.delayMs > 0) await Bun.sleep(token.delayMs);
      if (token.refuse !== undefined) return Response.json({ error: "invalid_grant", error_description: "Refresh token revoked" }, { status: token.refuse });
      return Response.json({ access_token: "sk-ant-oat-new-access", refresh_token: "sk-ant-ort-new-refresh", expires_in: 28_800 });
    },
  });
});
afterAll(() => token.server?.stop(true));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.stop().catch(() => {});
  globalThis.fetch = realFetch;
  token.requests.length = 0;
  token.delayMs = 0;
  token.refuse = undefined;
});

/** pi-ai's Anthropic flow posts to platform.claude.com: here, the local fake; anything else is refused. */
function toFakeTokenEndpoint(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input as Request, init);
    const url = new URL(request.url);
    if (url.origin !== "https://platform.claude.com") throw new Error(`no network in tests: ${url.origin}`);
    return realFetch(new Request(`http://127.0.0.1:${token.server?.port}${url.pathname}`, request));
  }) as typeof fetch;
}

const copy = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Cloudflare's objects, as far as credentials-do goes: a call reaches the App of its key. */
class Objects {
  readonly calls: string[] = [];
  /** Calls of `type` that fail like a lost subrequest: `before` the owner runs them, or `after` (the answer lost). */
  readonly faults: { type: string; when: "before" | "after"; times: number }[] = [];
  private readonly live = new Map<string, { answers: Map<string, ActorCallHandler>; ctx: () => AppContext }>();
  readonly mailbox: ActorMailbox = {
    send: async () => {
      throw new Error("credentials-do sends nothing");
    },
    call: async (key, type, message) => {
      this.calls.push(`${key} ${type}`);
      const object = this.live.get(key);
      const handler = object?.answers.get(type);
      if (object === undefined || handler === undefined) throw new ActorCallError("unreachable", `no object ${key} answers ${type}`);
      const fault = this.faults.find((each) => each.type === type && each.times > 0);
      if (fault !== undefined) fault.times--;
      if (fault?.when === "before") throw new Error("subrequest failed");
      const answer = callResult(await answerCall(handler, key, copy(message), object.ctx()));
      if (fault?.when === "after") throw new Error("subrequest failed");
      return answer;
    },
    stream: async (_key, type) => {
      throw new ActorCallError("no_handler", `credentials-do opens no stream (${type})`);
    },
  };
  /** The platform of the object `key`: its inbox and the mailbox. */
  platform(key: string): ComponentDefinition {
    const answers = new Map<string, ActorCallHandler>();
    const objects = this;
    return defineComponent({
      name: "platform-test",
      setup(pikit) {
        pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: (type, handler) => void answers.set(type, handler), answerStream: () => {} });
        pikit.provide("actor.mailbox", objects.mailbox);
        return {
          start(ctx) {
            const context = ctx.derive(() => BACKGROUND_CONTEXT);
            objects.live.set(key, { answers, ctx: () => context });
          },
          stop() {
            objects.live.delete(key);
          },
        };
      },
    });
  }
}

interface Logged {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}
const recording = (logged: Logged[]): Logger => {
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logged.push({ level, message, ...(fields !== undefined && { fields }) });
  return { ...silentLogger, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
};

interface Deployment {
  objects: Objects;
  clock: ManualClock;
  logged: Logged[];
  ownerStorage: ComponentDefinition;
  /** The owner object's App, started. */
  owner: App;
  /** A conversation object's `model.credentials`, in an App of its own. */
  conversation(key?: string): Promise<CredentialStore>;
  /** The owner object evicted: a new App over the same storage. */
  restartOwner(): Promise<void>;
}

async function deployment(config: Record<string, unknown> = {}): Promise<Deployment> {
  const objects = new Objects();
  const clock = createManualClock(Date.now());
  const logged: Logged[] = [];
  const logger = recording(logged);
  const ownerStorage = sqliteStorage();
  const startOwner = async () => {
    const app = await defineApp({ components: [ownerStorage, objects.platform(CREDENTIALS_KEY), credentialsDo], config: { "credentials-do": config }, logger, clock, target: "durable" }).create();
    await app.start();
    apps.push(app);
    return app;
  };
  const d: Deployment = {
    objects,
    clock,
    logged,
    ownerStorage,
    owner: await startOwner(),
    async conversation(key = `telegram:${crypto.randomUUID()}`) {
      let store: CredentialStore | undefined;
      const reader = defineComponent({
        name: "reader-test",
        setup(pikit) {
          const credentials = pikit.use("model.credentials");
          return { start: () => void (store = credentials.get()) };
        },
      });
      const app = await defineApp({ components: [sqliteStorage(), objects.platform(key), credentialsDo, reader], config: { "credentials-do": config }, logger, clock, target: "durable" }).create();
      await app.start();
      apps.push(app);
      return store as CredentialStore;
    },
    async restartOwner() {
      await d.owner.stop();
      d.owner = await startOwner();
    },
  };
  return d;
}

/** A stored Anthropic subscription login whose access token expired. */
const expired = { type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() - 1_000 } as const;

const ownerCall = (d: Deployment, type: string, message: JsonValue) => d.objects.mailbox.call(CREDENTIALS_KEY, type, message, d.owner.context());

const noSecretIn = (text: string) => {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

// The contract: what runtime-pi and provider-failover rely on, from a conversation's object.
for (const c of createCredentialStoreConformance(async () => {
  const d = await deployment();
  return { store: await d.conversation(), reopen: async () => (await d.restartOwner(), await d.conversation()) };
})) {
  test(`credentials-do ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it, for both halves", async () => {
  const objects = new Objects();
  const objectApp = await defineApp({ components: [sqliteStorage(), objects.platform("x"), credentialsDo], logger: silentLogger, target: "durable" }).create();
  expect(objectApp.describe().components.find((each) => each.name === "credentials-do")).toEqual({
    name: "credentials-do",
    provides: ["model.credentials"],
    requires: ["storage.sql", "actor.inbox", "actor.mailbox"],
    optional: [],
  });
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", objects.mailbox) });
  const workerApp = await defineApp({ components: [mailbox, worker], logger: silentLogger, target: "durable" }).create();
  expect(workerApp.describe().components.find((each) => each.name === "credentials-do-worker")).toEqual({
    name: "credentials-do-worker",
    provides: ["http.route"],
    requires: ["actor.mailbox"],
    optional: ["admin.auth"],
  });
});

test("an expired subscription token found by several conversations at once is refreshed once, in pi-ai's Anthropic flow, and every one gets the new tokens", async () => {
  toFakeTokenEndpoint();
  token.delayMs = 50;
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const stores = await Promise.all([d.conversation(), d.conversation(), d.conversation()]);

  const auths = await Promise.all(stores.flatMap((store) => [modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic"), modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic")]));

  expect(auths.map((auth) => auth?.auth.apiKey)).toEqual(Array(6).fill("sk-ant-oat-new-access"));
  // One refresh reached Anthropic, with the stored refresh token; the rotated one is what is stored now.
  expect(token.requests).toEqual([expect.objectContaining({ grant_type: "refresh_token", refresh_token: REFRESH })]);
  const stored = (await ownerCall(d, CALL.read, { providerId: "anthropic" })) as { credential: { access: string; refresh: string; expires: number } };
  expect([stored.credential.access, stored.credential.refresh]).toEqual(["sk-ant-oat-new-access", "sk-ant-ort-new-refresh"]);
  expect(stored.credential.expires).toBeGreaterThan(Date.now() + 60 * 60_000);
  // A conversation that comes later reads the new tokens: nothing is refreshed again.
  expect((await modelsFrom([anthropicProvider()], { credentials: await d.conversation() }).getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-oat-new-access");
  expect(token.requests).toHaveLength(1);
  noSecretIn(JSON.stringify(d.logged));
});

test("a refused refresh is reported once to every conversation waiting for it, never retried during the cooldown, then tried once again; the stored login stays", async () => {
  toFakeTokenEndpoint();
  token.delayMs = 30;
  token.refuse = 400;
  const d = await deployment({ retryAfterMs: 60_000 });
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const [a, b] = await Promise.all([d.conversation(), d.conversation()]);
  const auth = (store: CredentialStore) => modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic").then(
    () => "resolved",
    (error: unknown) => error as Error,
  );

  const failed = await Promise.all([auth(a), auth(b), auth(a)]);
  expect(failed.every((each) => each instanceof Error)).toBe(true);
  expect(token.requests).toHaveLength(1);
  // During the cooldown, no conversation reaches Anthropic.
  expect(await auth(b)).toBeInstanceOf(Error);
  await d.clock.advance(30_000);
  expect(await auth(a)).toBeInstanceOf(Error);
  expect(token.requests).toHaveLength(1);
  // What the runs are told names the provider and what to do, never a token.
  for (const error of [...failed, await auth(b)]) noSecretIn(`${String(error)} ${String((error as Error).cause)}`);
  // The one that refreshed gets pi-ai's refusal; the two that waited behind it, the owner's.
  expect(failed.filter((error) => String((error as Error).cause).includes("pikit configure --login anthropic"))).toHaveLength(2);

  // After it, one conversation tries once more.
  await d.clock.advance(30_000);
  token.refuse = undefined;
  expect(((await modelsFrom([anthropicProvider()], { credentials: b }).getAuth("anthropic")) as { auth: { apiKey: string } }).auth.apiKey).toBe("sk-ant-oat-new-access");
  expect(token.requests).toHaveLength(2);
  expect(d.logged.some((line) => line.level === "warn" && line.message.includes("refresh failed"))).toBe(true);
  noSecretIn(JSON.stringify(d.logged));
});

test("a refused refresh leaves the stored credential as it was, and an operator's new login ends the cooldown at once", async () => {
  toFakeTokenEndpoint();
  token.refuse = 401;
  const d = await deployment({ retryAfterMs: 3_600_000 });
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const store = await d.conversation();
  await expect(modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic")).rejects.toThrow();
  expect(await store.read("anthropic")).toEqual(expired);

  token.refuse = undefined;
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: { ...expired, refresh: "sk-ant-ort-new-refresh" } });
  expect(((await modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic")) as { auth: { apiKey: string } }).auth.apiKey).toBe("sk-ant-oat-new-access");
  expect(token.requests.at(-1)).toMatchObject({ refresh_token: "sk-ant-ort-new-refresh" });
});

test("an API key stored in the owner configures every conversation's provider, with no refresh", async () => {
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: { type: "api_key", key: "sk-ant-api-uploaded-key" } });
  const store = await d.conversation();
  expect((await modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-api-uploaded-key");
  expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
});

test("a lease whose holder died frees the lock once it expires; the late holder's release is refused and changes nothing", async () => {
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const first = (await ownerCall(d, CALL.acquire, { providerId: "anthropic" })) as { lease: string };

  let second: { lease: string } | undefined;
  const waiting = (ownerCall(d, CALL.acquire, { providerId: "anthropic" }) as Promise<{ lease: string }>).then((answer) => (second = answer));
  await d.clock.advance(LEASE_MS - 1);
  expect(second).toBeUndefined();
  await d.clock.advance(1);
  await waiting;
  expect(second?.lease).toBeString();
  expect(second?.lease).not.toBe(first.lease);

  const late = await ownerCall(d, CALL.release, { providerId: "anthropic", lease: first.lease, credential: { ...expired, access: "sk-ant-oat-late" } }).catch((error: unknown) => error);
  expect((late as ActorCallError).code).toBe("lease_lost");
  await ownerCall(d, CALL.release, { providerId: "anthropic", lease: (second as { lease: string }).lease });
  expect(((await ownerCall(d, CALL.read, { providerId: "anthropic" })) as { credential: { access: string } }).credential.access).toBe(ACCESS);
});

test("an operator's upload during a refresh waits for it, then wins", async () => {
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const { lease } = (await ownerCall(d, CALL.acquire, { providerId: "anthropic" })) as { lease: string };
  let uploaded = false;
  const upload = ownerCall(d, CALL.put, { providerId: "anthropic", credential: { type: "api_key", key: "sk-ant-api-uploaded-key" } }).then(() => (uploaded = true));
  await Bun.sleep(5);
  expect(uploaded).toBe(false);
  await ownerCall(d, CALL.release, { providerId: "anthropic", lease, credential: { ...expired, access: "sk-ant-oat-refreshed", expires: Date.now() + 3_600_000 } });
  await upload;
  expect((await ownerCall(d, CALL.read, { providerId: "anthropic" })) as unknown).toEqual({ credential: { type: "api_key", key: "sk-ant-api-uploaded-key" } });
});

/** How many calls of `type` reached the owner. */
const owned = (d: Deployment, type: string) => d.objects.calls.filter((each) => each === `${CREDENTIALS_KEY} ${type}`).length;

/** `promise`, while the clock moves on (a release's retries wait on it). */
async function whileAdvancing<T>(clock: ManualClock, promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await clock.advance(100);
  return promise;
}

const authOf = async (store: CredentialStore) => (await modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic"))?.auth.apiKey;

test("reads within the cache's TTL make one call to the owner, an absent credential included; after the TTL, one more; cacheTtlMs 0 asks every time", async () => {
  const d = await deployment();
  const key = { type: "api_key", key: "sk-ant-api-uploaded-key" } as const;
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: key });
  const store = await d.conversation();
  d.objects.calls.length = 0;

  for (let i = 0; i < 5; i++) expect(await store.read("anthropic")).toEqual(key);
  for (let i = 0; i < 3; i++) expect(await authOf(store)).toBe("sk-ant-api-uploaded-key");
  for (let i = 0; i < 3; i++) expect(await store.read("openai")).toBeUndefined();
  expect(owned(d, CALL.read)).toBe(2);

  await d.clock.advance(59_999);
  await store.read("anthropic");
  expect(owned(d, CALL.read)).toBe(2);
  await d.clock.advance(1);
  await store.read("anthropic");
  await store.read("anthropic");
  expect(owned(d, CALL.read)).toBe(3);

  const uncached = await deployment({ cacheTtlMs: 0 });
  await ownerCall(uncached, CALL.put, { providerId: "anthropic", credential: key });
  const each = await uncached.conversation();
  uncached.objects.calls.length = 0;
  for (let i = 0; i < 3; i++) await each.read("anthropic");
  expect(owned(uncached, CALL.read)).toBe(3);
});

test("an OAuth token is served from the cache only until pi-ai's refresh margin, so pi-ai sees it expiring and refreshes it through modify", async () => {
  toFakeTokenEndpoint();
  const d = await deployment();
  // 20 s before pi-ai would refresh it: kept 20 s, not the TTL's 60.
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: { ...expired, expires: d.clock.now() + OAUTH_REFRESH_MARGIN_MS + 20_000 } });
  const store = await d.conversation();
  d.objects.calls.length = 0;
  await store.read("anthropic");
  await store.read("anthropic");
  expect(owned(d, CALL.read)).toBe(1);
  await d.clock.advance(20_000);
  await store.read("anthropic");
  await store.read("anthropic");
  expect(owned(d, CALL.read)).toBe(3);

  // Within the margin: never kept; pi-ai refreshes it, and the refreshed token is kept.
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: { ...expired, expires: Date.now() + 60_000 } });
  const other = await d.conversation();
  d.objects.calls.length = 0;
  await other.read("anthropic");
  await other.read("anthropic");
  expect(owned(d, CALL.read)).toBe(2);
  expect(await authOf(other)).toBe("sk-ant-oat-new-access");
  expect(token.requests).toHaveLength(1);
  d.objects.calls.length = 0;
  expect(await authOf(other)).toBe("sk-ant-oat-new-access");
  expect(d.objects.calls).toEqual([]);
});

test("modify replaces what the object keeps and delete drops it; another object's write reaches it within the TTL", async () => {
  const d = await deployment();
  const [a, b] = [await d.conversation(), await d.conversation()];
  const key = (value: string): Credential => ({ type: "api_key", key: value });
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: key("sk-ant-api-a") as unknown as JsonValue });
  expect(await a.read("anthropic")).toEqual(key("sk-ant-api-a"));

  await a.modify("anthropic", async () => key("sk-ant-api-b"));
  d.objects.calls.length = 0;
  expect(await a.read("anthropic")).toEqual(key("sk-ant-api-b"));
  expect(d.objects.calls).toEqual([]);

  await b.modify("anthropic", async () => key("sk-ant-api-c"));
  expect(await a.read("anthropic")).toEqual(key("sk-ant-api-b"));
  await d.clock.advance(60_000);
  expect(await a.read("anthropic")).toEqual(key("sk-ant-api-c"));

  await a.delete("anthropic");
  d.objects.calls.length = 0;
  expect(await a.read("anthropic")).toBeUndefined();
  expect(owned(d, CALL.read)).toBe(1);
});

test("the owner takes a repeated release once: the same outcome answers as the first did, another is refused", async () => {
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const { lease } = (await ownerCall(d, CALL.acquire, { providerId: "anthropic" })) as { lease: string };
  const refreshed = { ...expired, access: "sk-ant-oat-new-access", refresh: "sk-ant-ort-new-refresh", expires: Date.now() + 3_600_000 };

  expect(await ownerCall(d, CALL.release, { providerId: "anthropic", lease, credential: refreshed })).toEqual({});
  expect(await ownerCall(d, CALL.release, { providerId: "anthropic", lease, credential: refreshed })).toEqual({});
  for (const other of [{ credential: { ...refreshed, access: "sk-ant-oat-late" } }, { failed: true }, {}]) {
    const refused = await ownerCall(d, CALL.release, { providerId: "anthropic", lease, ...other }).catch((error: unknown) => error);
    expect((refused as ActorCallError).code).toBe("lease_lost");
  }
  expect(((await ownerCall(d, CALL.read, { providerId: "anthropic" })) as { credential: unknown }).credential).toEqual(refreshed);
  // The lock is free.
  expect(await ownerCall(d, CALL.acquire, { providerId: "anthropic" })).toMatchObject({ lease: expect.any(String) });
});

test("a release that fails is tried again until the owner takes it, a repeat of one it took included: the refreshed tokens are stored", async () => {
  toFakeTokenEndpoint();
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const store = await d.conversation();
  d.objects.calls.length = 0;
  // Two lost before the owner, then one taken whose answer is lost.
  d.objects.faults.push({ type: CALL.release, when: "before", times: 2 }, { type: CALL.release, when: "after", times: 1 });

  expect(await whileAdvancing(d.clock, authOf(store))).toBe("sk-ant-oat-new-access");

  expect(owned(d, CALL.release)).toBe(4);
  expect(token.requests).toHaveLength(1);
  const stored = (await ownerCall(d, CALL.read, { providerId: "anthropic" })) as { credential: { refresh: string } };
  expect(stored.credential.refresh).toBe("sk-ant-ort-new-refresh");
  expect(d.logged.filter((line) => line.level === "error")).toEqual([]);
  // Another conversation gets the new tokens, with no refresh.
  expect(await authOf(await d.conversation())).toBe("sk-ant-oat-new-access");
  expect(token.requests).toHaveLength(1);
});

test("a refreshed token the owner never takes is kept by the object that refreshed it, logged without a secret, and written back at its next chance", async () => {
  toFakeTokenEndpoint();
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: expired });
  const store = await d.conversation();
  d.objects.faults.push({ type: CALL.release, when: "before", times: 4 });

  expect(await whileAdvancing(d.clock, authOf(store))).toBe("sk-ant-oat-new-access");
  expect(d.objects.faults[0]?.times).toBe(0);
  const ownerHolds = async () => ((await ownerCall(d, CALL.read, { providerId: "anthropic" })) as { credential: { refresh: string } }).credential.refresh;
  expect(await ownerHolds()).toBe(REFRESH);
  const errors = d.logged.filter((line) => line.level === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]?.fields).toMatchObject({ providerId: "anthropic", type: "oauth" });
  noSecretIn(JSON.stringify(d.logged));

  // This object keeps working with the rotated tokens, without asking the owner or the provider.
  d.objects.calls.length = 0;
  expect(await authOf(store)).toBe("sk-ant-oat-new-access");
  expect(d.objects.calls).toEqual([]);

  // After the TTL, its next read writes them back; then every conversation has them, with no refresh.
  await d.clock.advance(60_000);
  expect(await authOf(store)).toBe("sk-ant-oat-new-access");
  expect(await ownerHolds()).toBe("sk-ant-ort-new-refresh");
  expect(await authOf(await d.conversation())).toBe("sk-ant-oat-new-access");
  expect(token.requests).toHaveLength(1);
  noSecretIn(JSON.stringify(d.logged));
});

test("a credential of no known shape is refused by the owner, without saying what it held", async () => {
  const d = await deployment();
  for (const credential of [{ type: "oauth", access: ACCESS }, { type: "bearer", token: ACCESS }, ACCESS, { type: "api_key", key: 42 }]) {
    const refused = (await ownerCall(d, CALL.put, { providerId: "anthropic", credential: credential as JsonValue }).catch((error: unknown) => error)) as ActorCallError;
    expect(refused.code).toBe("invalid_request");
    noSecretIn(refused.message);
  }
  expect(((await ownerCall(d, CALL.put, { providerId: "../etc", credential: expired }).catch((error: unknown) => error)) as ActorCallError).code).toBe("invalid_request");
  expect(await ownerCall(d, CALL.list, null)).toEqual({ credentials: [] });
});

/** Operators: a bearer token. */
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === "Bearer ops" ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The Worker's App: credentials-do's half over the objects, its routes served by path. */
async function workerOf(d: Deployment, withAuth = true): Promise<(method: string, path: string, init?: RequestInit) => Promise<Response>> {
  let routes: { get(key: string): HttpRoute | undefined } | undefined;
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = handle) };
    },
  });
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", d.objects.mailbox) });
  const app = await defineApp({ components: [mailbox, ...(withAuth ? [auth] : []), worker, server], logger: recording(d.logged), target: "durable" }).create();
  await app.start();
  apps.push(app);
  return (method, path, init = {}) => {
    const key = path === "/admin/api/credentials-do" ? `${method} ${path}` : `${method} /admin/api/credentials-do/:providerId`;
    const route = routes?.get(key);
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(route(new Request(`https://bot.ana.workers.dev${path}`, { method, ...init }), app.context()));
  };
}

const OPS = { authorization: "Bearer ops" };
const login: Credential = { type: "oauth", access: "sk-ant-oat-new-access", refresh: "sk-ant-ort-new-refresh", expires: Date.now() + 3_600_000, accountId: "acct-1" };

test("the operator uploads a login through the Worker; every conversation uses it; no route ever answers a credential", async () => {
  const d = await deployment();
  const fetchWorker = await workerOf(d);

  const put = await fetchWorker("PUT", "/admin/api/credentials-do/anthropic", { headers: { ...OPS, "content-type": "application/json" }, body: JSON.stringify(login) });
  expect(put.status).toBe(200);
  const answered = await put.text();
  expect(JSON.parse(answered)).toEqual({ providerId: "anthropic", type: "oauth" });
  const listed = await fetchWorker("GET", "/admin/api/credentials-do", { headers: OPS });
  const list = await listed.text();
  expect(JSON.parse(list)).toEqual({ credentials: [{ providerId: "anthropic", type: "oauth" }] });
  expect(listed.headers.get("cache-control")).toBe("no-store");
  noSecretIn(answered + list);

  // A flow's own fields are kept.
  const store = await d.conversation();
  expect(await store.read("anthropic")).toEqual(login);
  expect((await modelsFrom([anthropicProvider()], { credentials: store }).getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-oat-new-access");

  const deleted = await fetchWorker("DELETE", "/admin/api/credentials-do/anthropic", { headers: OPS });
  expect(await deleted.json()).toEqual({ deleted: true });
  // A running conversation sees the delete once what it read is older than the cache's TTL.
  expect(await store.read("anthropic")).toEqual(login);
  await d.clock.advance(60_000);
  expect(await store.read("anthropic")).toBeUndefined();
  noSecretIn(JSON.stringify(d.logged));
});

test("a non-operator can neither upload, list nor delete: 401 before the owner is asked; without admin.auth, nobody can", async () => {
  const d = await deployment();
  await ownerCall(d, CALL.put, { providerId: "anthropic", credential: login as unknown as JsonValue });
  d.objects.calls.length = 0;
  for (const fetchWorker of [await workerOf(d), await workerOf(d, false)]) {
    for (const headers of [{}, { authorization: "Bearer eve" }]) {
      const responses = [
        await fetchWorker("GET", "/admin/api/credentials-do", { headers }),
        await fetchWorker("PUT", "/admin/api/credentials-do/anthropic", { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ type: "api_key", key: "sk-ant-api-uploaded-key" }) }),
        await fetchWorker("DELETE", "/admin/api/credentials-do/anthropic", { headers }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        noSecretIn(await response.text());
      }
    }
  }
  expect(d.objects.calls).toEqual([]);
  expect(await (await d.conversation()).read("anthropic")).toEqual(login);
});

test("a bad upload is refused 400, saying what is wrong and never echoing it", async () => {
  const d = await deployment();
  const fetchWorker = await workerOf(d);
  const bodies = ["not json " + ACCESS, JSON.stringify({ type: "oauth", access: ACCESS }), JSON.stringify({ type: "api_key", key: "x".repeat(20_000) })];
  for (const body of bodies) {
    const response = await fetchWorker("PUT", "/admin/api/credentials-do/anthropic", { headers: OPS, body });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error).toBe("invalid_request");
    noSecretIn(text);
    expect(text).not.toContain("xxxxxxxxxx");
  }
  expect((await fetchWorker("PUT", "/admin/api/credentials-do/Not%20an%20id", { headers: OPS, body: JSON.stringify(login) })).status).toBe(400);
  expect(await ownerCall(d, CALL.list, null)).toEqual({ credentials: [] });
  noSecretIn(JSON.stringify(d.logged));
});
