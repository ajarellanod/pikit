import { expect, test } from "bun:test";
import Type from "typebox";
import { createContextKey, withAbortSignal, withContextValue } from "./context.ts";
import { silentLogger } from "./contracts/logger.ts";
import { defineComponent, defineHarness, type HarnessOptions } from "./harness.ts";
import { Halt } from "./pipeline.ts";

declare module "./capabilities.ts" {
  interface HarnessCapabilities {
    "test.store": { name: string };
    "test.queue": { name: string };
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

test("setup runs providers before consumers regardless of list order; require works inside setup", async () => {
  const order: string[] = [];
  const consumer = defineComponent({
    name: "consumer",
    requires: ["test.store"],
    setup(pikit) {
      order.push(`consumer(${pikit.require("test.store").name})`);
    },
  });
  const store = defineComponent({
    name: "store",
    provides: ["test.store"],
    setup(pikit) {
      order.push("store");
      pikit.provide("test.store", { name: "mem" });
    },
  });

  const harness = await defineHarness(quiet({ components: [consumer, store] })).create();
  expect(order).toEqual(["store", "consumer(mem)"]);
  expect(harness.describe().components.map((c) => c.name)).toEqual(["store", "consumer"]);
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

test("composition errors fail in defineHarness, before any setup", () => {
  const setupRan = { value: false };
  const mk = (name: string, opts: { provides?: string[]; requires?: string[] } = {}) =>
    defineComponent({
      name,
      ...opts,
      setup() {
        setupRan.value = true;
      },
    });

  expect(() => defineHarness(quiet({ components: [mk("a", { requires: ["test.store"] })] }))).toThrow(
    'component "a" requires "test.store" but no installed component provides it',
  );
  expect(() =>
    defineHarness(
      quiet({
        components: [mk("s1", { provides: ["test.store"] }), mk("s2", { provides: ["test.store"] }), mk("c", { requires: ["test.store"] })],
      }),
    ),
  ).toThrow('several providers (s1, s2); select one with config.capabilities["test.store"]');
  expect(() =>
    defineHarness(
      quiet({
        components: [mk("s1", { provides: ["test.store"] })],
        config: { capabilities: { "test.store": "nope" } },
      }),
    ),
  ).toThrow('selects "nope", which does not declare it (declared by s1)');
  expect(() =>
    defineHarness(
      quiet({
        components: [
          mk("a", { provides: ["test.store"], requires: ["test.queue"] }),
          mk("b", { provides: ["test.queue"], requires: ["test.store"] }),
        ],
      }),
    ),
  ).toThrow("dependency cycle: a → b → a");
  expect(() => defineHarness(quiet({ components: [mk("a"), mk("a")] }))).toThrow('component "a" is listed twice');
  expect(() => defineComponent({ name: "Not_Kebab", setup() {} })).toThrow("must be kebab-case");
  expect(() => defineComponent({ name: "capabilities", setup() {} })).toThrow("reserved");

  expect(setupRan.value).toBe(false);
});

test("an unselected provider does not create a false dependency cycle", async () => {
  const mk = (name: string, provides: string[], requires: string[]) =>
    defineComponent({
      name,
      provides,
      requires,
      setup(pikit) {
        for (const capability of provides) pikit.provide(capability as "test.store", { name });
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

test("lifecycle: start in setup order, stop in reverse, events around the hooks", async () => {
  const seen: string[] = [];
  const mk = (name: string, provides: string[] = [], requires: string[] = []) =>
    defineComponent({
      name,
      provides,
      requires,
      setup(pikit) {
        for (const capability of provides) pikit.provide(capability as "test.store", { name });
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

test("provide is checked against the manifest, both ways", async () => {
  const sneaky = defineComponent({
    name: "sneaky",
    setup(pikit) {
      pikit.provide("test.store", { name: "x" });
    },
  });
  await expect(defineHarness(quiet({ components: [sneaky] })).create()).rejects.toThrow(
    'component "sneaky" provides "test.store" but its manifest does not declare it',
  );

  const lazy = defineComponent({ name: "lazy", provides: ["test.store"], setup() {} });
  await expect(defineHarness(quiet({ components: [lazy] })).create()).rejects.toThrow(
    'component "lazy" declares "test.store" but its setup did not provide it',
  );
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

  const def = defineHarness(quiet({ components: [http], config: { "channel-http": { path: "/hook" } } }));
  expect(def.config).toEqual({ "channel-http": { port: 8080, path: "/hook" } });
  await def.create();
  expect(received).toEqual({ port: 8080, path: "/hook" });

  expect(() => defineHarness(quiet({ components: [http], config: { "channel-http": { path: 42 } } }))).toThrow(
    "/channel-http/path");
  expect(() => defineHarness(quiet({ components: [http], config: { "chanel-http": {} } }))).toThrow("invalid config");
  expect(() => defineHarness(quiet({ components: [http] }))).toThrow("/channel-http"); // path is required
});

test("describe reflects selection and resolved pipeline chains; halt is emitted as pipeline.halted", async () => {
  const halted: string[] = [];
  const s1 = defineComponent({
    name: "s1",
    provides: ["test.store"],
    setup(pikit) {
      pikit.provide("test.store", { name: "s1" });
      pikit.pipeline("test.harness.text", (v) => ({ text: `${v.text}1` }), { id: "one", priority: 5 });
    },
  });
  const s2 = defineComponent({
    name: "s2",
    version: "1.0.0",
    provides: ["test.store"],
    setup(pikit) {
      pikit.provide("test.store", { name: "s2" });
      pikit.pipeline("test.harness.text", () => pikit.halt("no"), { id: "gate", after: "one" });
      pikit.on("pipeline.halted", (e) => {
        halted.push(`${e.pipeline}/${e.stage}:${e.reason}`);
      });
    },
  });

  const harness = await defineHarness(
    quiet({ components: [s1, s2], config: { capabilities: { "test.store": "s2" } } }),
  ).create();
  const d = harness.describe();

  expect(d.components.map((c) => c.name)).toEqual(["s1", "s2"]);
  expect(d.components[1]?.version).toBe("1.0.0");
  expect(d.capabilities).toEqual({ "test.store": { providers: ["s1", "s2"], selected: "s2" } });
  expect(d.pipelines["test.harness.text"]?.map((s) => s.id)).toEqual(["one", "gate"]);
  expect(harness.context().require("test.store").name).toBe("s2");

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
