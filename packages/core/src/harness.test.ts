import { expect, test } from "bun:test";
import Type from "typebox";
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

  expect(setupRan.value).toBe(false);
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

test("a run context carries its signal into handlers and nested emits", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const relay = defineComponent({
    name: "relay",
    setup(pikit) {
      pikit.on("test.harness.ping", async (e, ctx) => {
        seen.push(ctx.signal);
        if (e.via === "outer") await ctx.emit("test.harness.ping", { via: "inner" });
      });
    },
  });
  const harness = await defineHarness(quiet({ components: [relay] })).create();
  const controller = new AbortController();

  await harness.context({ signal: controller.signal }).emit("test.harness.ping", { via: "outer" });

  expect(seen).toEqual([controller.signal, controller.signal]);
  expect(harness.context().signal).toBeUndefined();
});
