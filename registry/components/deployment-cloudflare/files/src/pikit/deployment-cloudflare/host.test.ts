/**
 * The entrypoint's logic (`host.ts`) under Bun, with a fake object state and namespace: what reaches
 * each App's start context, when the object's App starts, how a failed or late start ends, and how the
 * Worker serves routes and `/health`. The same code runs in workerd in the workerd lane
 * (`tests/workerd/test/deployment-cloudflare.workerd.ts` in the pikit repository).
 */

import { expect, test } from "bun:test";
import { APP_DESCRIPTION, type AppContext, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import type { JsonValue } from "@pikit/contracts";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";
import { createActorKindConformance, createHttpRouteConformance, withoutActorKinds } from "@pikit/contracts/testing";
import { createObjectHost, createWorkerHost, createWorkerServer, GUARD_FIRST_MS, GUARD_MAX_MS, HEALTH_OBJECT, OBJECT_KEY, type ObjectState, START_FAILURES_KEY } from "./host.ts";

// What every handler can rely on (`http.route`): the Worker's server passes the suite, prefixes included.
for (const c of createHttpRouteConformance(() => {
  const server = createWorkerServer(silentLogger);
  return { components: [server.component], fetch: (path, init) => server.serve(new Request(`https://worker.test${path}`, init)) };
})) {
  test(`Worker server ${c.group}: ${c.name}`, () => c.run());
}

/** A DurableObjectStorage's part the host uses: its key-value storage and its alarm, in memory. */
function fakeStorage() {
  const values = new Map<string, unknown>();
  const storage = {
    values,
    alarm: null as number | null,
    get: async (key: string) => values.get(key),
    put: async (key: string, value: number | string) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => storage.alarm,
    setAlarm: async (time: number) => void (storage.alarm = time),
  };
  return storage;
}

/**
 * A DurableObjectState's part the entrypoint uses; counts `blockConcurrencyWhile` calls and whether one
 * is running. `name` is the one `idFromName` was given (Cloudflare's `ctx.id.name`); none, as for an
 * object the platform gives no name (`null`).
 */
function fakeState(name: string | null = "chat:1", id = `object-${name ?? "unnamed"}`) {
  const state = {
    id: { toString: () => id, name: name ?? undefined },
    storage: fakeStorage(),
    blocked: 0,
    inside: false,
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      state.blocked++;
      state.inside = true;
      try {
        return await callback();
      } finally {
        state.inside = false;
      }
    },
  };
  return state satisfies ObjectState;
}

/** Records the host it starts with, and registers handlers that record what they receive. */
function recorder() {
  const seen: { host?: WorkersHost | undefined; starts: number; alarms: number; delivered: [string, string, JsonValue][]; insideBlock: boolean[] } = {
    starts: 0,
    alarms: 0,
    delivered: [],
    insideBlock: [],
  };
  const component = (state?: { inside: boolean }) =>
    defineComponent({
      name: "platform-probe",
      setup() {
        return {
          start(ctx: AppContext) {
            seen.starts++;
            seen.insideBlock.push(state?.inside ?? false);
            seen.host = ctx.value(WORKERS_HOST);
            seen.host?.object?.onAlarm(async () => void seen.alarms++);
            seen.host?.object?.onDeliver(async (type, key, message) => void seen.delivered.push([type, key, message]));
          },
        };
      },
    });
  return { seen, component };
}

test("the object's App starts on its first event, once, inside blockConcurrencyWhile, with the object in WORKERS_HOST", async () => {
  const state = fakeState();
  const { seen, component } = recorder();
  const env = { SECRET: "s" };
  const host = createObjectHost(defineApp({ components: [component(state)] }), state, env, { logger: silentLogger });
  expect(seen.starts).toBe(0);

  await Promise.all([host.health(), host.deliver("text", "chat:1", { text: "hi" }), host.alarm()]);
  expect(seen.starts).toBe(1);
  expect(state.blocked).toBe(1);
  expect(seen.insideBlock).toEqual([true]);
  expect(seen.host?.env).toBe(env);
  expect(seen.host?.object?.id).toBe("object-chat:1");
  expect(seen.host?.object?.storage).toBe(state.storage);
  expect(seen.delivered).toEqual([["text", "chat:1", { text: "hi" }]]);
  expect(seen.alarms).toBe(1);
});

test("an alarm nobody handles is logged and dropped; a delivery nobody handles rejects, so its sender retries", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
  const host = createObjectHost(defineApp({ components: [] }), fakeState(), {}, { logger });
  await host.alarm();
  expect(warnings).toEqual(["pikit: the object's alarm fired, but no component handles it"]);
  await expect(host.deliver("text", "chat:1", null)).rejects.toThrow(/no component in the object's App handles deliveries/);
});

test("a second alarm, delivery or call handler fails the start: the object has one of each", async () => {
  for (const hook of ["onAlarm", "onDeliver", "onCall"] as const) {
    let refused: unknown;
    const twice = defineComponent({
      name: "twice",
      setup: () => ({
        start(ctx) {
          const object = ctx.value(WORKERS_HOST)?.object;
          const register = (object?.[hook] as ((handler: () => Promise<never>) => void) | undefined)?.bind(object);
          const handler = async (): Promise<never> => {
            throw new Error("never called");
          };
          register?.(handler);
          try {
            register?.(handler);
          } catch (error) {
            refused = error;
            throw error;
          }
        },
      }),
    });
    const host = createObjectHost(defineApp({ components: [twice] }), fakeState(), {}, { logger: silentLogger });
    await expect(host.health()).rejects.toThrow(/failed to start/);
    expect([hook, String(refused)]).toEqual([hook, expect.stringMatching(/already ha(s|ve) a handler/)]);
  }
});

test("a failed start rolls back, rethrows (Cloudflare resets the object), and the next event starts a new App", async () => {
  let attempt = 0;
  const stopped: string[] = [];
  const first = defineComponent({ name: "first", setup: () => ({ start() {}, stop: () => void stopped.push("first") }) });
  const flaky = defineComponent({
    name: "flaky",
    setup: () => ({
      start() {
        if (++attempt === 1) throw new Error("no database");
      },
    }),
  });
  const state = fakeState();
  const host = createObjectHost(defineApp({ components: [first, flaky] }), state, {}, { logger: silentLogger });
  const failure = await host.health().catch((error: unknown) => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('component "flaky" failed to start');
  expect(((failure as Error).cause as Error).message).toBe("no database");
  expect(stopped).toEqual(["first"]);

  await expect(host.health()).resolves.toEqual({ ok: true });
  expect(state.blocked).toBe(2);
});

test("while its start keeps failing, the alarm leaves a guard alarm set, further each time; once it starts, the pending work runs", async () => {
  let failing = true;
  let alarms = 0;
  const flaky = defineComponent({
    name: "flaky",
    setup: () => ({
      start(ctx) {
        if (failing) throw new Error("no database");
        ctx.value(WORKERS_HOST)?.object?.onAlarm(async () => void alarms++);
      },
    }),
  });
  const state = fakeState();
  const host = createObjectHost(defineApp({ components: [flaky] }), state, {}, { logger: silentLogger });
  /** The guard's wait after an alarm, in ms from when it was set; `null` when there is none. */
  const fail = async (info: { retryCount: number; isRetry: boolean }) => {
    // Cloudflare took the alarm that fired: during its handler, there is none.
    state.storage.alarm = null;
    const before = Date.now();
    await expect(host.alarm(info)).rejects.toThrow(/failed to start/);
    return state.storage.alarm === null ? null : state.storage.alarm - before;
  };

  // The first attempt is Cloudflare's to retry: no write.
  expect(await fail({ retryCount: 0, isRetry: false })).toBeNull();
  expect(state.storage.values.size).toBe(0);
  // Its retry sets the guard, which replaces the retries; each guard sets the next, twice as far, up to an hour.
  const waits = [await fail({ retryCount: 1, isRetry: true })];
  for (let i = 0; i < 9; i++) waits.push(await fail({ retryCount: 0, isRetry: false }));
  const expected = [1, 2, 4, 8, 16, 32, 64, 120, 120, 120].map((n) => Math.min(GUARD_MAX_MS, n * GUARD_FIRST_MS));
  waits.forEach((wait, i) => {
    expect(wait).toBeGreaterThanOrEqual(expected[i] as number);
    expect(wait).toBeLessThan((expected[i] as number) + 1_000);
  });
  expect(state.storage.values.get(START_FAILURES_KEY)).toBe(10);

  // A sooner alarm stands.
  state.storage.alarm = null;
  const sooner = Date.now() + 1_000;
  await state.storage.setAlarm(sooner);
  await expect(host.alarm({ retryCount: 0, isRetry: false })).rejects.toThrow(/failed to start/);
  expect(await state.storage.getAlarm()).toBe(sooner);

  // It starts: the alarm's work runs, and the count is gone (the App's own alarm owner replaces the guard).
  failing = false;
  await host.alarm({ retryCount: 0, isRetry: false });
  expect(alarms).toBe(1);
  expect(state.storage.values.has(START_FAILURES_KEY)).toBe(false);
  // A started App's alarms touch nothing.
  state.storage.alarm = null;
  await host.alarm({ retryCount: 1, isRetry: true });
  expect(alarms).toBe(2);
  expect(state.storage.alarm).toBeNull();
});

test("a start past its deadline, with a rollback that hangs, still ends within both deadlines (K2)", async () => {
  const hangs = defineComponent({
    name: "hangs",
    setup: () => ({
      start: () => new Promise<void>(() => {}),
    }),
  });
  const stuck = defineComponent({ name: "stuck", setup: () => ({ start() {}, stop: () => new Promise<void>(() => {}) }) });
  const host = createObjectHost(defineApp({ components: [stuck, hangs] }), fakeState(), {}, { logger: silentLogger, startDeadlineMs: 50, rollbackDeadlineMs: 50 });
  const started = Date.now();
  await expect(host.alarm()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1_000);
});

/**
 * A component that is up from its start to its stop, and whose first App's `runtime.ready` listener
 * never returns: the start deadline passes after every start ran, and the core abandons the listener
 * and resolves `start()` while the host's deadline is stopping the App. Each App records `up` from
 * its alarm handler and its `GET /up` route.
 */
function readyHangsOnce() {
  // Counted at start, not setup: an object's host also composes the App once (never started) to read its actor kinds.
  let apps = 0;
  let readies = 0;
  const alarms: boolean[] = [];
  const component = defineComponent({
    name: "ready-hangs-once",
    setup(pikit) {
      let up = false;
      pikit.on("runtime.ready", () => (++readies === 1 ? new Promise<void>(() => {}) : undefined));
      pikit.provideKeyed("http.route", "GET /up", () => Response.json({ up }));
      return {
        start(ctx) {
          apps++;
          up = true;
          ctx.value(WORKERS_HOST)?.object?.onAlarm(async () => void alarms.push(up));
        },
        stop() {
          up = false;
        },
      };
    },
  });
  return { component, alarms, apps: () => apps };
}

test("an object's App stopped by its start deadline is never used, even when its start resolved; the next event starts a new App", async () => {
  const { component, alarms, apps } = readyHangsOnce();
  const state = fakeState();
  const host = createObjectHost(defineApp({ components: [component] }), state, {}, { logger: silentLogger, startDeadlineMs: 50, rollbackDeadlineMs: 50 });

  await expect(host.alarm()).rejects.toThrow(/did not start within 50 ms/);
  expect(alarms).toEqual([]);

  await host.alarm();
  expect(alarms).toEqual([true]);
  expect(apps()).toBe(2);
  expect(state.blocked).toBe(2);
});

test("a Worker's App stopped by its start deadline never serves, even when its start resolved; the next request starts a new App", async () => {
  const { component, apps } = readyHangsOnce();
  const worker = createWorkerHost(defineApp({ components: [component] }), { logger: silentLogger, startDeadlineMs: 50, rollbackDeadlineMs: 50 });

  const env = { CONVERSATION: fakeNamespace(async () => ({ ok: true })) };

  // Not 200 from a stopped App, which every later request of the isolate would reach ({ up: false }).
  const health = await worker.fetch(new Request("https://w.example/health"), env);
  expect(health.status).toBe(503);
  expect(await health.json()).toEqual({ ok: false, version: null, error: "the Worker's App did not start" });
  const next = await worker.fetch(new Request("https://w.example/up"), env);
  expect(next.status).toBe(200);
  expect(await next.json()).toEqual({ up: true });
  expect(apps()).toBe(2);
});

test("the Worker's App starts once per isolate with WORKERS_HOST { env, origin }, and serves its routes with contexts of their own", async () => {
  let starts = 0;
  let startSignal: AbortSignal | undefined;
  let hostSeen: WorkersHost | undefined;
  const routes = defineComponent({
    name: "routes",
    setup(pikit) {
      pikit.provideKeyed("http.route", "GET /hello", (request, ctx) =>
        Response.json({ env: Object.keys(ctx.value(WORKERS_HOST)?.env ?? {}), sameSignal: ctx.abortSignal === startSignal, url: new URL(request.url).pathname }),
      );
      pikit.provideKeyed("http.route", "GET /chats/:id", (request) => Response.json({ route: "param", path: new URL(request.url).pathname }));
      pikit.provideKeyed("http.route", "GET /chats/new", () => Response.json({ route: "literal" }));
      pikit.provideKeyed("http.route", "POST /boom", () => {
        throw new Error("a secret detail");
      });
      return {
        start(ctx) {
          starts++;
          startSignal = ctx.abortSignal;
          hostSeen = ctx.value(WORKERS_HOST);
        },
      };
    },
  });
  const worker = createWorkerHost(defineApp({ components: [routes] }), { logger: silentLogger });
  const env = { A: "1" };

  const hello = await worker.fetch(new Request("https://w.example/hello"), env);
  expect(hello.status).toBe(200);
  // Handlers never get start's context, nor WORKERS_HOST (it is for start, SPEC C5).
  expect(await hello.json()).toEqual({ env: [], sameSignal: false, url: "/hello" });
  // The origin of the request that started it: where the Worker is reached.
  expect(hostSeen).toEqual({ env, origin: "https://w.example" });
  expect(await (await worker.fetch(new Request("https://w.example/chats/new"), env)).json()).toEqual({ route: "literal" });
  expect(await (await worker.fetch(new Request("https://w.example/chats/42"), env)).json()).toEqual({ route: "param", path: "/chats/42" });
  expect((await worker.fetch(new Request("https://w.example/nothing"), env)).status).toBe(404);
  expect((await worker.fetch(new Request("https://w.example/hello", { method: "POST" }), env)).status).toBe(404);
  const boom = await worker.fetch(new Request("https://w.example/boom", { method: "POST" }), env);
  expect(boom.status).toBe(500);
  expect(await boom.text()).not.toContain("secret");
  expect(starts).toBe(1);
});

test("the Worker refuses routes it cannot serve, and a failed start answers 503 and is retried by the next request", async () => {
  let refuse = true;
  const routes = defineComponent({
    name: "routes",
    setup(pikit) {
      pikit.provideKeyed("http.route", "GET /health", () => new Response("mine"));
      return {
        start() {
          if (refuse) throw new Error("not yet");
        },
      };
    },
  });
  const worker = createWorkerHost(defineApp({ components: [routes] }), { logger: silentLogger });
  expect((await worker.fetch(new Request("https://w.example/x"), {})).status).toBe(503);
  refuse = false;
  // Now it starts, and its "GET /health" is refused: that route is the Worker's own.
  expect((await worker.fetch(new Request("https://w.example/x"), {})).status).toBe(503);
});

/** A namespace whose objects answer `health()` as `answer` does, recording the names asked. */
function fakeNamespace(answer: () => Promise<unknown>) {
  const names: string[] = [];
  return {
    names,
    idFromName: (name: string) => (names.push(name), { name }),
    get: () => ({ health: answer }),
  };
}

test("GET /health starts the Worker's App and one object's App, and answers { ok, version }", async () => {
  const objects = fakeNamespace(async () => ({ ok: true }));
  const worker = createWorkerHost(undefined, { logger: silentLogger });
  const env = { CONVERSATION: objects, CF_VERSION_METADATA: { id: "version-2", tag: "", timestamp: "" } };
  const response = await worker.fetch(new Request("https://w.example/health"), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, version: "version-2" });
  expect(objects.names).toEqual([HEALTH_OBJECT]);
  // Without a Worker App, the Worker serves /health only.
  expect((await worker.fetch(new Request("https://w.example/other"), env)).status).toBe(404);

  // /health starts the Worker's App too, with its origin: the first request a version serves may be it.
  let hostSeen: WorkersHost | undefined;
  const reader = defineComponent({ name: "reader", setup: () => ({ start: (ctx) => void (hostSeen = ctx.value(WORKERS_HOST)) }) });
  await createWorkerHost(defineApp({ components: [reader] }), { logger: silentLogger }).fetch(new Request("https://bot.acme.workers.dev/health"), env);
  expect(hostSeen?.origin).toBe("https://bot.acme.workers.dev");
});

test("GET /health says which half did not start, never why", async () => {
  const failing = createWorkerHost(undefined, { logger: silentLogger });
  const objects = fakeNamespace(async () => {
    throw new Error("the database password is hunter2");
  });
  const down = await failing.fetch(new Request("https://w.example/health"), { CONVERSATION: objects });
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({ ok: false, version: null, error: "the object's App did not start" });

  const broken = defineComponent({ name: "broken", setup: () => ({ start: () => Promise.reject(new Error("hunter2")) }) });
  const worker = createWorkerHost(defineApp({ components: [broken] }), { logger: silentLogger });
  const answer = await worker.fetch(new Request("https://w.example/health"), { CONVERSATION: fakeNamespace(async () => ({ ok: true })) });
  expect(answer.status).toBe(503);
  expect(await answer.json()).toEqual({ ok: false, version: null, error: "the Worker's App did not start" });

  const unbound = await createWorkerHost(undefined, { logger: silentLogger }).fetch(new Request("https://w.example/health"), {});
  expect(((await unbound.json()) as { error: string }).error).toContain("no CONVERSATION binding");
});

test("a route sees cf-connecting-ip as x-pikit-client-address, never the client's own copy of it; none without it", async () => {
  const routes = defineComponent({
    name: "routes",
    setup: (pikit) => pikit.provideKeyed("http.route", "GET /who", (request) => Response.json({ address: request.headers.get("x-pikit-client-address") })),
  });
  const worker = createWorkerHost(defineApp({ components: [routes] }), { logger: silentLogger });
  const seen = async (headers: Record<string, string>) => ((await (await worker.fetch(new Request("https://w.example/who", { headers }), {})).json()) as { address: string | null }).address;
  expect(await seen({ "cf-connecting-ip": "198.51.100.7", "x-pikit-client-address": "203.0.113.9" })).toBe("198.51.100.7");
  expect(await seen({ "x-pikit-client-address": "203.0.113.9" })).toBeNull();
});

// ---- Actor kinds (SPEC C9): which App an object runs ----

declare module "@pikit/core" {
  interface AppCapabilities {
    "test.host-store": Map<string, JsonValue>;
  }
}

/**
 * A small project, as an object's host sees it: `actors` (the object's RPC and alarm through
 * `WORKERS_HOST`, as actors-do; a mailbox recording the keys it reaches), `store`, `counter` (the owner
 * of the keys `counter:`, declared unless `declare` is false), and `conversation`, whose start calls
 * another actor (as runtime-pi's start read the credentials) and which handles `text`. Each object's
 * App records the components it is made of (its own `APP_DESCRIPTION`), and each component's setups
 * are counted.
 */
function kindProject(options: { declare?: boolean; extra?: ReturnType<typeof defineComponent>[] } = {}) {
  const seen = { apps: [] as string[][], reached: [] as string[], setups: new Map<string, number>(), rows: new Map<string, JsonValue>(), alarms: 0 };
  const counted = (name: string) => seen.setups.set(name, (seen.setups.get(name) ?? 0) + 1);
  const actors = defineComponent({
    name: "actors",
    setup(pikit) {
      counted("actors");
      const answers = new Map<string, (key: string, message: JsonValue) => Promise<JsonValue>>();
      const handlers = new Map<string, (key: string, message: JsonValue) => Promise<void>>();
      pikit.provide("actor.inbox", {
        scope: "one",
        handle: (type, handler) => void handlers.set(type, (key, message) => handler(key, message, undefined as never)),
        answer: (type, handler) => void answers.set(type, (key, message) => handler(key, message, undefined as never)),
        answerStream: () => {},
      });
      pikit.provide("actor.mailbox", {
        send: async (key) => void seen.reached.push(key),
        call: async (key) => (seen.reached.push(key), null),
        stream: async () => {
          throw new Error("no streams");
        },
      });
      pikit.provide("wakeups", { handle: () => {}, at: async () => {}, cancel: async () => {} });
      return {
        start(ctx) {
          seen.apps.push((ctx.value(APP_DESCRIPTION)?.components ?? []).map((c) => c.name));
          const object = ctx.value(WORKERS_HOST)?.object;
          object?.onAlarm(async () => void seen.alarms++);
          object?.onDeliver(async (type, key, message) => {
            const handler = handlers.get(type);
            if (handler === undefined) throw new Error(`actors: no handler for "${type}"`);
            await handler(key, message);
          });
          object?.onCall?.(async (type, key, message) => {
            const answer = answers.get(type);
            return answer === undefined ? { ok: false, code: "no_handler", message: `actors: no answer handler for "${type}"` } : { ok: true, answer: await answer(key, message) };
          });
        },
      };
    },
  });
  const store = defineComponent({
    name: "store",
    setup(pikit) {
      counted("store");
      pikit.provide("test.host-store", seen.rows);
    },
  });
  const conversation = defineComponent({
    name: "conversation",
    setup(pikit) {
      counted("conversation");
      const mailbox = pikit.use("actor.mailbox");
      const inbox = pikit.use("actor.inbox");
      return {
        async start(ctx) {
          await mailbox.get().call("credentials-do", "credentials-do.read", null, ctx);
          inbox.get().handle("text", async () => {});
        },
      };
    },
  });
  const counter = defineComponent({
    name: "counter",
    setup(pikit) {
      counted("counter");
      const rows = pikit.use("test.host-store");
      const inbox = pikit.use("actor.inbox");
      if (options.declare !== false) pikit.provideKeyed("actor.kind", "counter", { prefixes: ["counter:"] });
      return {
        start() {
          inbox.get().answer("counter.add", async (key, message) => {
            const count = ((rows.get().get(key) as number | undefined) ?? 0) + (message as number);
            rows.get().set(key, count);
            return count;
          });
        },
      };
    },
  });
  return { seen, components: [actors, store, conversation, counter, ...(options.extra ?? [])] };
}

/** A namespace whose ids are `id-<name>`, as the host checks an event's key against. */
const namedIds = { idFromName: (name: string) => ({ toString: () => `id-${name}` }), get: () => ({ health: async () => ({ ok: true }) }) };

test("an object of a kind's key runs its kind's App, with no call to another actor; a conversation's and a key of no kind, the whole App", async () => {
  const { seen, components } = kindProject();
  const definition = defineApp({ components });
  const counter = createObjectHost(definition, fakeState("counter:1"), {}, { logger: silentLogger });
  expect(await counter.call("counter.add", "counter:1", 2)).toEqual({ ok: true, answer: 2 });
  expect(seen.apps).toEqual([["actors", "store", "counter"]]);
  expect(seen.reached).toEqual([]);

  await createObjectHost(definition, fakeState("chat:1"), {}, { logger: silentLogger }).deliver("text", "chat:1", "hi");
  await createObjectHost(definition, fakeState("telegram:5"), {}, { logger: silentLogger }).health();
  expect(seen.apps.slice(1)).toEqual([
    ["actors", "store", "conversation", "counter"],
    ["actors", "store", "conversation", "counter"],
  ]);
  expect(seen.reached).toEqual(["credentials-do", "credentials-do"]);
});

test("the whole App is composed once per isolate to read the kinds (never started), not per object", async () => {
  const { seen, components } = kindProject();
  const definition = defineApp({ components });
  for (const key of ["counter:1", "counter:2", "counter:3"]) await createObjectHost(definition, fakeState(key), {}, { logger: silentLogger }).call("counter.add", key, 1);
  // One reading composition, then three kind Apps: the conversation never set up in them.
  expect(Object.fromEntries(seen.setups)).toEqual({ actors: 4, store: 4, conversation: 1, counter: 4 });
  expect(seen.reached).toEqual([]);
  // A project that declares nothing: every object the whole App, as before C9.
  const plain = kindProject({ declare: false });
  await createObjectHost(defineApp({ components: plain.components }), fakeState("counter:1"), {}, { logger: silentLogger }).call("counter.add", "counter:1", 1);
  expect(plain.seen.apps).toEqual([["actors", "store", "conversation", "counter"]]);
});

test("an object's key: the event's, checked to be its own; else the platform's name; else the one it kept (pikit:key); else none, the whole App", async () => {
  const { seen, components } = kindProject();
  const definition = defineApp({ components });

  // Named by the platform: another key is refused before anything starts.
  const named = fakeState("counter:1");
  const refused = await createObjectHost(definition, named, {}, { logger: silentLogger }).call("counter.add", "counter:2", 1);
  expect(refused).toEqual({ ok: false, code: "invalid", message: expect.stringContaining("its key is not this object's name: refused") });
  expect(named.blocked).toBe(0);
  // The message names the object, never the key.
  expect((refused as { message: string }).message).not.toContain("counter:2");

  // No name: the key is checked by idFromName against the object's id, and kept for its alarms.
  const unnamed = fakeState(null, "id-counter:7");
  const host = createObjectHost(definition, unnamed, { CONVERSATION: namedIds }, { logger: silentLogger });
  expect(await host.call("counter.add", "counter:6", 1)).toEqual({ ok: false, code: "invalid", message: expect.stringContaining("its key names another object") });
  await expect(host.deliver("text", "chat:1", null)).rejects.toThrow(/its key names another object/);
  expect(await host.call("counter.add", "counter:7", 1)).toEqual({ ok: true, answer: 1 });
  expect(unnamed.storage.values.get(OBJECT_KEY)).toBe("counter:7");
  // Its next instance, woken by its alarm, finds its kind again from what it kept.
  await createObjectHost(definition, unnamed, { CONVERSATION: namedIds }, { logger: silentLogger }).alarm();
  // The binding checked is the host's: another class's binding name works the same way.
  await createObjectHost(definition, fakeState(null, "id-counter:8"), { OTHER: namedIds }, { logger: silentLogger, binding: "OTHER" }).call("counter.add", "counter:8", 1);
  // Named, the alarm needs nothing kept.
  const alarmed = fakeState("counter:9");
  await createObjectHost(definition, alarmed, {}, { logger: silentLogger }).alarm();
  expect(alarmed.storage.values.has(OBJECT_KEY)).toBe(false);
  // Nothing known (an object made before C9 woken by its alarm): the whole App.
  await createObjectHost(definition, fakeState(null, "id-old"), { CONVERSATION: namedIds }, { logger: silentLogger }).alarm();
  expect(seen.apps).toEqual([
    ["actors", "store", "counter"],
    ["actors", "store", "counter"],
    ["actors", "store", "counter"],
    ["actors", "store", "counter"],
    ["actors", "store", "conversation", "counter"],
  ]);

  // No name and no binding to check against: refused, saying which.
  await expect(createObjectHost(definition, fakeState(null), {}, { logger: silentLogger }).deliver("text", "chat:1", null)).rejects.toThrow(/no CONVERSATION binding to check its key against/);
});

test("a declaration problem fails every object's start, conversations' too", async () => {
  const wrong = defineComponent({ name: "wrong", setup: (pikit) => pikit.provideKeyed("actor.kind", "wrong", { prefixes: ["pikit:"] }) });
  const { components } = kindProject({ extra: [wrong] });
  const definition = defineApp({ components });
  for (const key of ["chat:1", "counter:1"]) {
    await expect(createObjectHost(definition, fakeState(key), {}, { logger: silentLogger }).health()).rejects.toThrow(/actor kinds are refused \(SPEC C9\):\n {2}actor.kind "wrong": declares "pikit:"/);
  }
});

test("health() starts its App and creates every kind's App: a kind that does not compose fails it, naming the kind", async () => {
  const { components } = kindProject();
  await createObjectHost(defineApp({ components }), fakeState(HEALTH_OBJECT), {}, { logger: silentLogger }).health();

  // A part that composes in the whole App and not in the kind's: its third setup (reading, the health
  // object's whole App, then the kind's) throws.
  let setups = 0;
  const fragile = defineComponent({
    name: "fragile",
    setup(pikit) {
      if (++setups === 3) throw new Error("not this time");
      pikit.provideKeyed("actor.kind", "fragile", { keys: ["fragile"] });
    },
  });
  const broken = kindProject({ extra: [fragile] });
  const host = createObjectHost(defineApp({ components: broken.components }), fakeState(HEALTH_OBJECT), {}, { logger: silentLogger });
  await expect(host.health()).rejects.toThrow('deployment-cloudflare: the actor kind "fragile" (fragile) does not compose: not this time');
  // The health object's own App is the whole one.
  expect(broken.seen.apps).toEqual([["actors", "store", "conversation", "counter", "fragile"]]);
});

test("a call or message a kind's object has no handler for says which kind it runs; the whole App's says nothing more", async () => {
  const { components } = kindProject();
  const definition = defineApp({ components });
  const counter = createObjectHost(definition, fakeState("counter:1"), {}, { logger: silentLogger });
  const note = 'this object runs the actor kind "counter:": actors, store, counter, not the whole App; a component that handles "text" on these keys declares actor.kind for them too';
  expect(await counter.call("text", "counter:1", null)).toEqual({ ok: false, code: "no_handler", message: `actors: no answer handler for "text" (${note}, SPEC C9)` });
  await expect(counter.deliver("text", "counter:1", null)).rejects.toThrow(`actors: no handler for "text" (${note}, SPEC C9)`);
  expect(await createObjectHost(definition, fakeState("chat:1"), {}, { logger: silentLogger }).call("counter.nope", "chat:1", null)).toEqual({
    ok: false,
    code: "no_handler",
    message: 'actors: no answer handler for "counter.nope"',
  });
});

test("the object's start is logged with its kind (the pattern, never the key), its components, compose and start times, and the isolate", async () => {
  const lines: [string, Record<string, unknown> | undefined][] = [];
  const logger: Logger = { ...silentLogger, info: (message, fields) => void lines.push([message, fields as Record<string, unknown>]) };
  const { components } = kindProject();
  await createObjectHost(defineApp({ components }), fakeState("counter:secret-person"), {}, { logger }).call("counter.add", "counter:secret-person", 1);
  const started = lines.find(([message]) => message === "pikit: object started")?.[1];
  expect(started).toEqual({ object: "object-counter:secret-person", kind: "counter:", components: 3, composeMs: expect.any(Number), startMs: expect.any(Number), isolate: expect.stringMatching(/^(new|warm)$/) });
  expect(lines.find(([message]) => message === "pikit: actor kinds read")?.[1]).toEqual({ kinds: 1, components: 4, ms: expect.any(Number) });
});

// The equivalence suite over this host: a `counter:` object running the whole App and its kind's.
for (const c of createActorKindConformance(() => ({
  key: "counter:1",
  steps: [
    { call: "counter.add", message: 2 },
    { call: "counter.add", message: 3 },
    { call: "counter.missing", message: null },
    { send: "counter.missing", message: null },
  ],
  async open(app) {
    const { seen, components } = kindProject();
    const host = createObjectHost(defineApp({ components: app === "whole" ? withoutActorKinds(components) : components }), fakeState("counter:1"), {}, { logger: silentLogger });
    await host.health();
    const startCalls = [...seen.reached];
    return {
      send: (type, message) => host.deliver(type, "counter:1", message),
      call: (type, message) => host.call(type, "counter:1", message),
      rows: async () => Object.fromEntries(seen.rows),
      startCalls: () => startCalls,
    };
  },
}))) {
  test(`host ${c.group}: ${c.name}`, () => c.run());
}
