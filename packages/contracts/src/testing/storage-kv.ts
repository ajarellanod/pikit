/**
 * `storage.kv` conformance: what every `KeyValueStorage` must do, wherever its data lives.
 * Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createKeyValueConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite reaches the storage through the capability, as a component would.
 */

import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { JsonValue } from "../json.ts";
import type { KeyValueStorage } from "../storage.ts";
import { checker, expecter } from "./assert.ts";

/** A fresh, empty storage, built for one case. */
export interface KeyValueFixture {
  /**
   * The component providing `storage.kv`, and anything it uses. The suite may create several apps
   * from them over the same data, one after the other, so the data lives outside the components'
   * setup (in the fixture: a file, a map).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Release what the fixture holds (temporary files). */
  dispose?(): Promise<void>;
}

const GROUP = "storage.kv";
const expect = expecter(GROUP);
const check = checker(GROUP);

const rejects = (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(
    () => false,
    () => true,
  );

export function createKeyValueConformance(factory: () => KeyValueFixture | Promise<KeyValueFixture>): readonly ConformanceCase[] {
  const kvCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const apps: App[] = [];
      try {
        await run(createSubject(fixture, apps));
      } finally {
        for (const app of apps) await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    kvCase("every kind of JSON value reads back as it was written; a missing key is undefined, null is a value", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      const values: Record<string, JsonValue> = {
        text: "ñandú ✓ \"quoted\" 'single' \\ \n tab\t",
        integer: 9_007_199_254_740_991,
        real: -1.5,
        yes: true,
        no: false,
        nothing: null,
        list: [1, "two", null, [3], { four: 4 }],
        object: { nested: { deep: [true, { x: "y" }] }, empty: {} },
      };
      for (const [key, value] of Object.entries(values)) await kv.set(key, value);
      for (const [key, value] of Object.entries(values)) expect(await kv.get(key), value, `the value at "${key}"`);
      expect(await kv.get("missing"), undefined, "a key never written");
    }),

    kvCase("set replaces a value; delete removes it, and deleting a missing key is not an error", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      await kv.set("k", "first");
      await kv.set("k", { second: 2 });
      expect(await kv.get("k"), { second: 2 }, "the second value");
      await kv.delete("k");
      expect(await kv.get("k"), undefined, "no value after delete");
      await kv.delete("k");
      await kv.delete("never-written");
    }),

    kvCase("a value read back is a copy: changing what was written or read changes nothing stored", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      const written = { list: [1, 2] };
      await kv.set("k", written);
      written.list.push(3);
      const read = await kv.get<{ list: number[] }>("k");
      read?.list.push(4);
      expect(await kv.get("k"), { list: [1, 2] }, "the value as it was written");
    }),

    kvCase("namespaces never see each other's keys, whatever their names contain", async (s) => {
      const storage = await s.open();
      const a = storage.namespace("a");
      const b = storage.namespace("b");
      await a.set("k", "a's");
      expect(await b.get("k"), undefined, "a key of another namespace");
      await b.set("k", "b's");
      await b.delete("k");
      expect(await a.get("k"), "a's", "a value another namespace wrote and deleted under the same key");
      // A provider that joins namespace and key into one string must not let these meet.
      for (const [namespace, key] of [["x:y", "z"], ["x", "y:z"], ["x/y", "z"], ["x", "y/z"]] as const) {
        await storage.namespace(namespace).set(key, `${namespace}|${key}`);
      }
      for (const [namespace, key] of [["x:y", "z"], ["x", "y:z"], ["x/y", "z"], ["x", "y/z"]] as const) {
        expect(await storage.namespace(namespace).get(key), `${namespace}|${key}`, `the value of ${JSON.stringify(namespace)} / ${JSON.stringify(key)}`);
      }
    }),

    kvCase("keys are any string: empty, unicode, and the characters SQL patterns use", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      const keys = ["", "ñandú ✓", "100%", "a_b", "it's", "\"q\"", "back\\slash"];
      for (const key of keys) await kv.set(key, key);
      for (const key of keys) expect(await kv.get(key), key, `the value at ${JSON.stringify(key)}`);
      expect(await kv.get("a%b"), undefined, "no key matched as a pattern");
    }),

    kvCase("setIfAbsent writes only a missing key; of concurrent calls for one, exactly one writes", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      expect(await kv.setIfAbsent("once", "first"), true, "setIfAbsent on a missing key");
      expect(await kv.setIfAbsent("once", "second"), false, "setIfAbsent on a key with a value");
      expect(await kv.get("once"), "first", "the first value");
      await kv.set("nulled", null);
      expect(await kv.setIfAbsent("nulled", "other"), false, "setIfAbsent on a key whose value is null");

      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => kv.setIfAbsent("race", i)));
      const winners = results.flatMap((wrote, i) => (wrote ? [i] : []));
      expect(winners.length, 1, "how many concurrent setIfAbsent calls wrote");
      expect(await kv.get("race"), winners[0], "the value of the one that wrote");
    }),

    kvCase("a value that is not JSON is refused, and nothing is stored", async (s) => {
      const kv = (await s.open()).namespace("conformance");
      check(await rejects(kv.set("k", undefined as unknown as JsonValue)), "set with undefined to reject");
      check(await rejects(kv.setIfAbsent("k", (() => 1) as unknown as JsonValue)), "setIfAbsent with a function to reject");
      expect(await kv.get("k"), undefined, "no value after the refused writes");
    }),

    kvCase("values survive a new app over the same storage", async (s) => {
      await (await s.open()).namespace("conformance").set("kept", { yes: true });
      await s.stopAll();
      expect(await (await s.open()).namespace("conformance").get("kept"), { yes: true }, "the value, after a restart");
    }),
  ];
}

interface Subject {
  /** Starts a new app over the fixture's storage and returns its `storage.kv`. */
  open(): Promise<KeyValueStorage>;
  /** Stops every app started so far, as a process that exits. */
  stopAll(): Promise<void>;
}

function createSubject(fixture: KeyValueFixture, apps: App[]): Subject {
  return {
    async open() {
      let storage: KeyValueStorage | undefined;
      const consumer = defineComponent({
        name: "storage-kv-conformance",
        setup(pikit) {
          const handle = pikit.use("storage.kv");
          return {
            start() {
              storage = handle.get();
            },
          };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      apps.push(app);
      await app.start();
      if (storage === undefined) throw new Error(`${GROUP}: storage.kv was not resolved`);
      return storage;
    },
    async stopAll() {
      for (const app of apps.splice(0)) await app.stop();
    },
  };
}

/**
 * `storage.kv` in memory, for tests: the data lives as long as the object, so apps started one after
 * the other over it see the same values, as they would over a file. Values are kept as JSON text, so
 * they are copies and a value that is not JSON is refused, as a real provider does.
 */
export function createMemoryKeyValueStorage(): KeyValueStorage {
  const entries = new Map<string, string>();
  const at = (namespace: string, key: string) => JSON.stringify([namespace, key]);
  const serialize = (value: JsonValue): string => {
    const text = JSON.stringify(value) as string | undefined;
    if (text === undefined) throw new TypeError("storage.kv: a value must be JSON");
    return text;
  };
  return {
    namespace(name) {
      return {
        async get<T extends JsonValue = JsonValue>(key: string) {
          const text = entries.get(at(name, key));
          return text === undefined ? undefined : (JSON.parse(text) as T);
        },
        async set(key, value) {
          entries.set(at(name, key), serialize(value));
        },
        async setIfAbsent(key, value) {
          const text = serialize(value);
          if (entries.has(at(name, key))) return false;
          entries.set(at(name, key), text);
          return true;
        },
        async delete(key) {
          entries.delete(at(name, key));
        },
      };
    },
  };
}
