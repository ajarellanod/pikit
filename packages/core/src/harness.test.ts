import { expect, test } from "bun:test";
import Type from "typebox";
import { BACKGROUND_CONTEXT, createContextKey, withAbortSignal, withContextValue } from "./context.ts";
import { silentLogger } from "./contracts/logger.ts";
import { defineComponent, defineHarness, type HarnessOptions, type Pikit } from "./harness.ts";
import { Halt } from "./pipeline.ts";

declare module "./capabilities.ts" {
  interface HarnessCapabilities {
    "test.store": { name: string };
    "test.queue": { name: string };
  }
  interface HarnessKeyedCapabilities {
    "test.transport": { channel: string };
  }
}
declare module "./events.ts" {
  interface HarnessEvents {
    "test.harness.ping": { via: string };
  }
}
declare module "./pipeline.ts" {
  interface HarnessPipelines {
    "test.harness.text": { text: string };
  }
}

const quiet = (options: HarnessOptions): HarnessOptions => ({ logger: silentLogger, ...options });

test("start runs providers before consumers regardless of list order; handles resolve after setup", async () => {
  const order: string[] = [];
  const consumer = defineComponent({
    name: "consumer",
    setup(pikit) {
      order.push("setup consumer");
      const store = pikit.use("test.store");
      return {
        start: () => {
          order.push(`start consumer(${store.get().name})`);
        },
      };
    },
  });
  const store = defineComponent({
    name: "store",
    setup(pikit) {
      order.push("setup store");
      pikit.provide("test.store", { name: "mem" });
      return {
        start: () => {
          order.push("start store");
        },
      };
    },
  });

  const harness = await defineHarness(quiet({ components: [consumer, store] })).create();
  await harness.start();
  expect(order).toEqual(["setup consumer", "setup store", "start store", "start consumer(mem)"]);
  expect(harness.describe().components).toEqual([
    { name: "store", provides: ["test.store"], requires: [], optional: [] },
    { name: "consumer", provides: [], requires: ["test.store"], optional: [] },
  ]);
});

test("runtime.* events fire in order on start/stop; extensions are components", async () => {
  const seen: string[] = [];
  const audit = defineComponent({
    name: "audit",
    setup(pikit) {
      for (const name of ["runtime.starting", "runtime.ready", "runtime.stopping", "runtime.stopped"] as const) {
        pikit.on(name, () => {
          seen.push(name);
        });
      }
    },
  });

  const harness = await defineHarness(quiet({ components: [], extensions: [audit] })).create();
  await harness.start();
  await expect(harness.start()).rejects.toThrow("already started");
  await harness.stop();
  await harness.stop(); // idempotent

  expect(seen).toEqual(["runtime.starting", "runtime.ready", "runtime.stopping", "runtime.stopped"]);
});

test("composition errors fail in create(), after every setup and before any start", async () => {
  const started: string[] = [];
  const mk = (name: string, opts: { provides?: string[]; uses?: string[] } = {}) =>
    defineComponent({
      name,
      setup(pikit) {
        for (const capability of opts.provides ?? []) pikit.provide(capability as "test.store", { name });
        for (const capability of opts.uses ?? []) pikit.use(capability as "test.store");
        return {
          start: () => {
            started.push(name);
          },
        };
      },
    });
  const create = (options: HarnessOptions) => defineHarness(quiet(options)).create();

  await expect(create({ components: [mk("a", { uses: ["test.store"] })] })).rejects.toThrow(
    'component "a" uses "test.store" but no installed component provides it',
  );
  await expect(
    create({
      components: [mk("s1", { provides: ["test.store"] }), mk("s2", { provides: ["test.store"] }), mk("c", { uses: ["test.store"] })],
    }),
  ).rejects.toThrow('several providers (s1, s2); select one with config.capabilities["test.store"]');
  await expect(
    create({
      components: [mk("s1", { provides: ["test.store"] }), mk("other")],
      config: { capabilities: { "test.store": "other" } },
    }),
  ).rejects.toThrow('selects "other", which does not provide it (provided by s1)');
  await expect(
    create({
      components: [
        mk("a", { provides: ["test.store"], uses: ["test.queue"] }),
        mk("b", { provides: ["test.queue"], uses: ["test.store"] }),
      ],
    }),
  ).rejects.toThrow("dependency cycle: a → b → a");
  expect(started).toEqual([]);

  // Names, selection targets and config fail even earlier, in defineHarness.
  expect(() => defineHarness(quiet({ components: [mk("a"), mk("a")] }))).toThrow('component "a" is listed twice');
  expect(() =>
    defineHarness(quiet({ components: [mk("s1")], config: { capabilities: { "test.store": "nope" } } })),
  ).toThrow('selects "nope", which is not an installed component');
  expect(() => defineComponent({ name: "Not_Kebab", setup() {} })).toThrow("must be kebab-case");
  expect(() => defineComponent({ name: "capabilities", setup() {} })).toThrow("reserved");
});

test("an unselected provider does not create a false dependency cycle", async () => {
  const mk = (name: string, provides: string[], uses: string[]) =>
    defineComponent({
      name,
      setup(pikit) {
        for (const capability of provides) pikit.provide(capability as "test.store", { name });
        for (const capability of uses) pikit.use(capability as "test.store");
      },
    });
  // store-b needs thing-c; thing-c needs test.store, which is store-a (selected), not store-b.
  const harness = await defineHarness(
    quiet({
      config: { capabilities: { "test.store": "store-a" } },
      components: [mk("store-a", ["test.store"], []), mk("store-b", ["test.store"], ["test.queue"]), mk("thing-c", ["test.queue"], ["test.store"])],
    }),
  ).create();
  expect(harness.describe().components.map((c) => c.name)).toEqual(["store-a", "thing-c", "store-b"]);
});

test("lifecycle: start in dependency order, stop in reverse, events around the hooks", async () => {
  const seen: string[] = [];
  const mk = (name: string, provides: string[] = [], uses: string[] = []) =>
    defineComponent({
      name,
      setup(pikit) {
        for (const capability of provides) pikit.provide(capability as "test.store", { name });
        for (const capability of uses) pikit.use(capability as "test.store");
        const resource = `${name}-resource`; // setup-local state reaches start/stop via closure
        return {
          start: () => {
            seen.push(`start ${resource}`);
          },
          stop: () => {
            seen.push(`stop ${resource}`);
          },
        };
      },
    });
  const events = defineComponent({
    name: "events",
    setup(pikit) {
      for (const name of ["runtime.starting", "runtime.ready", "runtime.stopping", "runtime.stopped"] as const) {
        pikit.on(name, () => {
          seen.push(name);
        });
      }
    },
  });

  const harness = await defineHarness(
    quiet({ components: [events, mk("consumer", [], ["test.store"]), mk("store", ["test.store"])] }),
  ).create();
  await harness.start();
  await harness.stop();

  expect(seen).toEqual([
    "runtime.starting",
    "start store-resource",
    "start consumer-resource",
    "runtime.ready",
    "runtime.stopping",
    "stop consumer-resource",
    "stop store-resource",
    "runtime.stopped",
  ]);
});

test("a failed start rolls back what started, never emits ready, and can be retried", async () => {
  const seen: string[] = [];
  let portBusy = true;
  const db = defineComponent({
    name: "storage-db",
    setup: () => ({
      start: () => {
        seen.push("db open");
      },
      stop: () => {
        seen.push("db close");
      },
    }),
  });
  const server = defineComponent({
    name: "server-http",
    setup(pikit) {
      for (const name of ["runtime.ready", "runtime.stopped"] as const) {
        pikit.on(name, () => {
          seen.push(name);
        });
      }
      return {
        start: () => {
          if (portBusy) throw new Error("EADDRINUSE");
          seen.push("listening");
        },
        stop: () => {
          seen.push("server close");
        },
      };
    },
  });

  const harness = await defineHarness(quiet({ components: [db, server] })).create();
  const failure = await harness.start().catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('component "server-http" failed to start');
  expect(((failure as Error).cause as Error).message).toBe("EADDRINUSE");
  expect(seen).toEqual(["db open", "db close", "runtime.stopped"]);

  portBusy = false;
  seen.length = 0;
  await harness.start();
  expect(seen).toEqual(["db open", "listening", "runtime.ready"]);
});

test("stop runs every stop hook and reports all failures together", async () => {
  const stopped: string[] = [];
  const mk = (name: string, fails: boolean) =>
    defineComponent({
      name,
      setup: () => ({
        stop: () => {
          stopped.push(name);
          if (fails) throw new Error(`${name} broke`);
        },
      }),
    });
  const harness = await defineHarness(quiet({ components: [mk("a", true), mk("b", false), mk("c", true)] })).create();
  await harness.start();

  const failure = await harness.stop().catch((error: AggregateError) => error);
  expect(stopped).toEqual(["c", "b", "a"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
    'component "c" failed to stop',
    'component "a" failed to stop',
  ]);
  await harness.stop(); // already stopped: no-op
});

test("useOptional: absent is undefined; present is ordered first like any dependency", async () => {
  const seen: string[] = [];
  const channel = defineComponent({
    name: "channel",
    setup(pikit) {
      const queue = pikit.useOptional("test.queue");
      return {
        start: () => {
          seen.push(`channel sees ${queue.get()?.name ?? "no queue"}`);
        },
      };
    },
  });
  const outbox = defineComponent({
    name: "outbox",
    setup(pikit) {
      pikit.provide("test.queue", { name: "outbox" });
      return {
        start: () => {
          seen.push("outbox started");
        },
      };
    },
  });

  const alone = await defineHarness(quiet({ components: [channel] })).create();
  await alone.start();
  expect(alone.describe().components).toEqual([{ name: "channel", provides: [], requires: [], optional: ["test.queue"] }]);

  const both = await defineHarness(quiet({ components: [channel, outbox] })).create();
  await both.start();
  expect(seen).toEqual(["channel sees no queue", "outbox started", "channel sees outbox"]);

  // Optional is not "anything goes": several providers still need a selection.
  const second = defineComponent({ name: "outbox-2", setup: (pikit) => pikit.provide("test.queue", { name: "2" }) });
  await expect(defineHarness(quiet({ components: [channel, outbox, second] })).create()).rejects.toThrow(
    "several providers (outbox, outbox-2)",
  );

  // use() and useOptional() of the same name in one setup: required wins.
  const both2 = defineComponent({
    name: "both",
    setup(pikit) {
      pikit.useOptional("test.queue");
      pikit.use("test.queue");
    },
  });
  await expect(defineHarness(quiet({ components: [both2] })).create()).rejects.toThrow(
    'component "both" uses "test.queue" but no installed component provides it',
  );

  // The verb is the declaration: there is no option that config could switch.
  // @ts-expect-error: use() takes no options
  const flagged = (pikit: Pikit) => pikit.use("test.queue", { optional: true });
  void flagged;
});

test("keyed capabilities: every provider contributes keys; consumers start after all of them", async () => {
  const seen: string[] = [];
  const channel = (name: string, key: string) =>
    defineComponent({
      name,
      setup(pikit) {
        pikit.provideKeyed("test.transport", key, { channel: key });
        return {
          start: () => {
            seen.push(`start ${name}`);
          },
        };
      },
    });
  const outbox = defineComponent({
    name: "outbox",
    setup(pikit) {
      const transports = pikit.useKeyed("test.transport");
      return {
        start: () => {
          seen.push(
            `outbox sees ${transports.keys().join(",")}; http=${transports.get("http")?.channel}; sms=${transports.get("sms")}`,
          );
        },
      };
    },
  });

  const harness = await defineHarness(
    quiet({ components: [outbox, channel("channel-http", "http"), channel("channel-telegram", "telegram")] }),
  ).create();
  await harness.start();

  expect(seen).toEqual([
    "start channel-http",
    "start channel-telegram",
    "outbox sees http,telegram; http=http; sms=undefined",
  ]);
  expect(harness.describe().capabilities["test.transport"]).toEqual({
    providers: ["channel-http", "channel-telegram"],
    keys: { http: "channel-http", telegram: "channel-telegram" },
  });
});

test("keyed and single modes cannot be mixed, keys are unique, and keyed ignores selection", async () => {
  const create = (options: HarnessOptions) => defineHarness(quiet(options)).create();
  const keyed = (name: string, key: string) =>
    defineComponent({ name, setup: (pikit) => pikit.provideKeyed("test.transport", key, { channel: key }) });

  await expect(create({ components: [keyed("a", "http"), keyed("b", "http")] })).rejects.toThrow(
    'capability "test.transport": key "http" is provided by both "a" and "b"',
  );
  await expect(
    create({
      components: [
        keyed("a", "http"),
        defineComponent({ name: "b", setup: (pikit) => pikit.provide("test.transport" as "test.store", { name: "b" }) }),
      ],
    }),
  ).rejects.toThrow('capability "test.transport" is keyed (provided by a); component "b" provides it without a key');
  await expect(
    create({
      components: [keyed("a", "http"), defineComponent({ name: "c", setup: (pikit) => void pikit.use("test.transport" as "test.store") })],
    }),
  ).rejects.toThrow('component "c" uses "test.transport" with use()/useOptional(), but it is keyed; use useKeyed()');
  await expect(
    create({
      components: [
        defineComponent({ name: "s", setup: (pikit) => pikit.provide("test.store", { name: "s" }) }),
        defineComponent({ name: "c", setup: (pikit) => void pikit.useKeyed("test.store" as "test.transport") }),
      ],
    }),
  ).rejects.toThrow('component "c" uses "test.store" with useKeyed(), but it is provided without a key');
  await expect(
    create({ components: [keyed("a", "http")], config: { capabilities: { "test.transport": "a" } } }),
  ).rejects.toThrow('"test.transport" is keyed and every provider is used');

  // No provider is a normal state for a keyed capability, not a composition error.
  let keys: string[] = ["unset"];
  const relaxed = defineComponent({
    name: "relaxed",
    setup(pikit) {
      const transports = pikit.useKeyed("test.transport");
      return {
        start: () => {
          keys = transports.keys();
        },
      };
    },
  });
  const harness = await create({ components: [relaxed] });
  await harness.start();
  expect(keys).toEqual([]);
  expect(harness.describe().components).toEqual([
    { name: "relaxed", provides: [], requires: [], optional: ["test.transport"] },
  ]);
});

test("registration is sealed when setup returns", async () => {
  let saved: Pikit | undefined;
  const sneaky = defineComponent({
    name: "sneaky",
    setup(pikit) {
      saved = pikit;
    },
  });
  const harness = await defineHarness(quiet({ components: [sneaky] })).create();
  const late = saved as Pikit;

  expect(() => late.provide("test.store", { name: "late" })).toThrow(
    'component "sneaky": provide("test.store") is only allowed during setup',
  );
  expect(() => late.provideKeyed("test.transport", "k", { channel: "k" })).toThrow("only allowed during setup");
  expect(() => late.use("test.store")).toThrow('use("test.store") is only allowed during setup');
  expect(() => late.useKeyed("test.transport")).toThrow("only allowed during setup");
  expect(() => late.on("runtime.ready", () => {})).toThrow('on("runtime.ready") is only allowed during setup');
  expect(() => late.pipeline("test.harness.text", (v) => v)).toThrow("only allowed during setup");
  expect(harness.describe().capabilities).toEqual({});
});

test("stop() during start() cancels it; the rollback is bounded by stop's deadline; concurrent stops share one shutdown", async () => {
  const log: string[] = [];
  let blockStart = true;
  let releaseFast: () => void = () => {};
  const fast = defineComponent({
    name: "fast",
    setup: () => ({
      start: () => {
        log.push("fast started");
      },
      // Hangs during the rollback: only the stop deadline can end it.
      stop: () => {
        log.push("fast stop called");
        if (blockStart) {
          return new Promise<void>((resolve) => {
            releaseFast = resolve;
          });
        }
      },
    }),
  });
  const slow = defineComponent({
    name: "slow",
    setup: () => ({
      // Cooperative: gives up when the harness cancels the start.
      start: (ctx) =>
        blockStart
          ? new Promise<void>((_, reject) => {
              ctx.abortSignal?.addEventListener("abort", () => {
                log.push("slow start aborted");
                reject(ctx.abortSignal?.reason);
              });
            })
          : undefined,
    }),
  });
  const harness = await defineHarness(quiet({ components: [fast, slow] })).create();

  const starting = harness.start();
  await new Promise((resolve) => setTimeout(resolve, 5)); // fast is up, slow is still starting
  const first = harness.stop(withAbortSignal(AbortSignal.timeout(20), BACKGROUND_CONTEXT));
  const second = harness.stop();
  expect(second).toBe(first);
  await expect(harness.start()).rejects.toThrow("harness is stopping");
  await first;
  const error = await starting.catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('component "slow" failed to start');
  expect(((error as Error).cause as Error).message).toBe("harness is stopping");
  expect(log).toEqual(["fast started", "slow start aborted", "fast stop called"]);

  // The abandoned stop still runs and shares fast's closure: no restart beside it.
  await expect(harness.start()).rejects.toThrow("abandoned work still running (fast.stop)");
  releaseFast();
  await new Promise((resolve) => setTimeout(resolve, 0));
  blockStart = false;
  await harness.start(); // a stopped harness can start again
  await harness.stop();
});

test("start(ctx): a start that outlives its deadline is abandoned and rolled back without that deadline", async () => {
  const log: string[] = [];
  let rollbackSignal: AbortSignal | undefined;
  const first = defineComponent({
    name: "first",
    setup: () => ({
      start: () => {
        log.push("first started");
      },
      stop: (ctx) => {
        rollbackSignal = ctx.abortSignal;
        log.push("first stopped");
      },
    }),
  });
  const hung = defineComponent({
    name: "hung",
    // Ignores cancellation entirely: the harness must not wait for it.
    setup: () => ({ start: () => new Promise<void>(() => {}) }),
  });
  const harness = await defineHarness(quiet({ components: [first, hung] })).create();

  const error = await harness.start(withAbortSignal(AbortSignal.timeout(20), BACKGROUND_CONTEXT)).catch((e: Error) => e);
  expect((error as Error).message).toBe('component "hung" failed to start');
  expect(((error as Error).cause as DOMException).name).toBe("TimeoutError");
  expect(log).toEqual(["first started", "first stopped"]);
  // The expired start deadline did not reach the rollback.
  expect(rollbackSignal?.aborted).toBe(false);
});

test("stop(ctx): a stop that outlives its deadline is abandoned and reported; the rest still stop", async () => {
  const log: string[] = [];
  const events: string[] = [];
  const store = defineComponent({
    name: "store",
    setup(pikit) {
      pikit.provide("test.store", { name: "mem" });
      pikit.on("runtime.stopped", () => void events.push("runtime.stopped"));
      return {
        stop: () => {
          log.push("store stopped");
        },
      };
    },
  });
  const hung = defineComponent({
    name: "hung",
    setup(pikit) {
      pikit.use("test.store");
      return { stop: () => new Promise<void>(() => {}) };
    },
  });
  const harness = await defineHarness(quiet({ components: [hung, store] })).create();
  await harness.start();

  const error = await harness.stop(withAbortSignal(AbortSignal.timeout(20), BACKGROUND_CONTEXT)).catch((e: Error) => e);
  expect(error).toBeInstanceOf(AggregateError);
  const [abandoned] = (error as AggregateError).errors as Error[];
  expect(abandoned?.message).toBe('component "hung" failed to stop');
  expect((abandoned?.cause as DOMException).name).toBe("TimeoutError");
  expect(log).toEqual(["store stopped"]);
  expect(events).toEqual(["runtime.stopped"]);
});

test("runtime.* listeners share the lifecycle deadline: a hung one is abandoned, the rest proceeds", async () => {
  const log: string[] = [];
  const watcher = defineComponent({
    name: "watcher",
    setup(pikit) {
      pikit.on("runtime.stopping", () => new Promise<void>(() => {}));
      pikit.on("runtime.stopped", () => void log.push("runtime.stopped"));
      return {
        stop: () => {
          log.push("watcher stopped");
        },
      };
    },
  });
  const harness = await defineHarness(quiet({ components: [watcher] })).create();
  await harness.start();
  await harness.stop(withAbortSignal(AbortSignal.timeout(20), BACKGROUND_CONTEXT));
  expect(log).toEqual(["watcher stopped", "runtime.stopped"]);
});

test("abandoned work is logged and blocks a restart until it settles", async () => {
  const logs: string[] = [];
  const logger = {
    ...silentLogger,
    warn: (_: string, fields?: Record<string, unknown>) => void logs.push(`warn ${String(fields?.step)}`),
    info: (_: string, fields?: Record<string, unknown>) => void logs.push(`info ${String(fields?.step)}`),
  };
  let release: () => void = () => {};
  let hang = true;
  const lagging = defineComponent({
    name: "lagging",
    setup: () => ({
      stop: () => {
        if (!hang) return;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    }),
  });
  const harness = await defineHarness({ components: [lagging], logger }).create();
  await harness.start();
  await expect(harness.stop(withAbortSignal(AbortSignal.timeout(20), BACKGROUND_CONTEXT))).rejects.toThrow(
    "harness stopped with errors",
  );
  expect(logs).toEqual(["warn lagging.stop"]);

  // The late stop shares lagging's closure: starting beside it could release the new run.
  await expect(harness.start()).rejects.toThrow("abandoned work still running (lagging.stop)");

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(logs).toEqual(["warn lagging.stop", "info lagging.stop"]);
  hang = false;
  await harness.start();
  await harness.stop();
});

test("setup is synchronous and handles cannot be resolved during it", async () => {
  const eager = defineComponent({
    name: "eager",
    setup(pikit) {
      pikit.use("test.store").get();
    },
  });
  const store = defineComponent({
    name: "store",
    setup(pikit) {
      pikit.provide("test.store", { name: "mem" });
    },
  });
  await expect(defineHarness(quiet({ components: [store, eager] })).create()).rejects.toThrow(
    'component "eager": "test.store" is not available during setup; call get() in start or later',
  );
  const eagerKeyed = defineComponent({
    name: "eager-keyed",
    setup(pikit) {
      pikit.useKeyed("test.transport").keys();
    },
  });
  await expect(defineHarness(quiet({ components: [eagerKeyed] })).create()).rejects.toThrow(
    'component "eager-keyed": "test.transport" is not available during setup',
  );

  const asyncSetup = defineComponent({
    name: "async-setup",
    // @ts-expect-error: setup must be synchronous; the type rejects it and so does the harness.
    async setup() {},
  });
  await expect(defineHarness(quiet({ components: [asyncSetup] })).create()).rejects.toThrow(
    'component "async-setup": setup must be synchronous; acquire resources in start',
  );
});

test("setup only registers: pikit has no emit, run, derive or invocation context", async () => {
  let keys: string[] = [];
  const probe = defineComponent({
    name: "probe",
    setup(pikit) {
      keys = Object.keys(pikit);
    },
  });
  await defineHarness(quiet({ components: [probe] })).create();
  expect(keys.sort()).toEqual(
    ["target", "config", "logger", "clock", "on", "pipeline", "provide", "provideKeyed", "use", "useOptional", "useKeyed", "halt"].sort(),
  );

  // Type level too: doing work in setup does not compile.
  const work = (pikit: Pikit) => {
    // @ts-expect-error: emitting is work; emit from start or a handler's ctx
    void pikit.emit("test.harness.ping", { via: "setup" });
    // @ts-expect-error: running a pipeline is work
    void pikit.run("test.harness.text", { text: "" });
    // @ts-expect-error: setup has no invocation context to derive from
    void pikit.derive((c: never) => c);
    // @ts-expect-error: setup has no cancellation
    void pikit.abortSignal;
    // @ts-expect-error: setup has no invocation values
    void pikit.value;
  };
  void work;
});

test("config is validated and defaulted per component; typos and bad values are errors", async () => {
  let received: unknown;
  const http = defineComponent({
    name: "channel-http",
    config: Type.Object({ port: Type.Number({ default: 8080 }), path: Type.String() }),
    setup(_, config) {
      received = config;
    },
  });

  const raw = { "channel-http": { path: "/hook" } };
  const def = defineHarness(quiet({ components: [http], config: raw }));
  expect(def.config).toEqual({ "channel-http": { port: 8080, path: "/hook" } });
  await def.create();
  expect(received).toEqual({ port: 8080, path: "/hook" });

  // Shared by every component, so frozen: a mutation throws where it happens.
  expect(() => {
    (received as { port: number }).port = 1;
  }).toThrow(TypeError);
  // The caller's objects are copied, never defaulted or frozen in place.
  expect(raw).toEqual({ "channel-http": { path: "/hook" } });
  expect(Object.isFrozen(raw["channel-http"])).toBe(false);

  expect(() => defineHarness(quiet({ components: [http], config: { "channel-http": { path: 42 } } }))).toThrow(
    "/channel-http/path");
  expect(() => defineHarness(quiet({ components: [http], config: { "chanel-http": {} } }))).toThrow("invalid config");
  expect(() => defineHarness(quiet({ components: [http] }))).toThrow("/channel-http"); // path is required
});

test("describe reflects selection and resolved pipeline chains; halt is emitted as pipeline.halted", async () => {
  const halted: string[] = [];
  let chosen = "";
  const s1 = defineComponent({
    name: "s1",
    setup(pikit) {
      pikit.provide("test.store", { name: "s1" });
      pikit.pipeline("test.harness.text", (v) => ({ text: `${v.text}1` }), { id: "one", priority: 5 });
    },
  });
  const s2 = defineComponent({
    name: "s2",
    version: "1.0.0",
    setup(pikit) {
      pikit.provide("test.store", { name: "s2" });
      pikit.pipeline("test.harness.text", () => pikit.halt("no"), { id: "gate", after: "one" });
      pikit.on("pipeline.halted", (e) => {
        halted.push(`${e.pipeline}/${e.stage}:${e.reason}`);
      });
    },
  });
  const reader = defineComponent({
    name: "reader",
    setup(pikit) {
      const store = pikit.use("test.store");
      return {
        start: () => {
          chosen = store.get().name;
        },
      };
    },
  });

  const harness = await defineHarness(
    quiet({ components: [s1, s2, reader], config: { capabilities: { "test.store": "s2" } } }),
  ).create();
  await harness.start();
  const d = harness.describe();

  expect(d.components.map((c) => c.name)).toEqual(["s1", "s2", "reader"]);
  expect(d.components[1]?.version).toBe("1.0.0");
  expect(d.capabilities).toEqual({ "test.store": { providers: ["s1", "s2"], selected: "s2" } });
  expect(d.pipelines["test.harness.text"]?.map((s) => s.id)).toEqual(["one", "gate"]);
  expect(chosen).toBe("s2");

  const result = await harness.context().run("test.harness.text", { text: "" });
  expect(result).toBeInstanceOf(Halt);
  expect(halted).toEqual(["test.harness.text/gate:no"]);
});

test("a context carries cancellation and values into handlers, nested emits and derivations", async () => {
  const TENANT = createContextKey<string>("tenant");
  const HOP = createContextKey<number>("hop");
  const seen: { signal: AbortSignal | undefined; tenant: string | undefined; hop: number | undefined }[] = [];
  const relay = defineComponent({
    name: "relay",
    setup(pikit) {
      pikit.on("test.harness.ping", async (e, ctx) => {
        seen.push({ signal: ctx.abortSignal, tenant: ctx.value(TENANT), hop: ctx.value(HOP) });
        if (e.via === "outer") {
          await ctx.derive((c) => withContextValue(HOP, 2, c)).emit("test.harness.ping", { via: "inner" });
        }
      });
    },
  });
  const harness = await defineHarness(quiet({ components: [relay] })).create();
  const controller = new AbortController();
  const request = withContextValue(TENANT, "acme", withAbortSignal(controller.signal, harness.context()));

  await harness.context(request).emit("test.harness.ping", { via: "outer" });

  expect(seen).toEqual([
    { signal: controller.signal, tenant: "acme", hop: undefined },
    { signal: controller.signal, tenant: "acme", hop: 2 },
  ]);
  expect(harness.context().abortSignal).toBeUndefined();
  expect(harness.context().value(TENANT)).toBeUndefined();
});
