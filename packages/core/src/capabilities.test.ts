import { expect, test } from "bun:test";
import { createCapabilityRegistry } from "./capabilities.ts";

interface Caps {
  "storage.sql": { kind: string };
  "outbound.queue": { push(): void };
}
interface KeyedCaps {
  "channel.transport": { channel: string };
}

test("single provider resolves; missing capability names what is required", () => {
  const caps = createCapabilityRegistry<Caps>();
  caps.provide("storage.sql", { kind: "sqlite" }, "storage-sqlite");

  expect(caps.require("storage.sql")).toEqual({ kind: "sqlite" });
  expect(caps.has("storage.sql")).toBe(true);
  expect(caps.has("outbound.queue")).toBe(false);
  expect(() => caps.require("outbound.queue")).toThrow(
    'capability "outbound.queue" is required but no installed component provides it',
  );
});

test("two providers are ambiguous unless config selects one", () => {
  const unselected = createCapabilityRegistry<Caps>();
  unselected.provide("storage.sql", { kind: "sqlite" }, "storage-sqlite");
  unselected.provide("storage.sql", { kind: "postgres" }, "storage-postgres");
  expect(() => unselected.require("storage.sql")).toThrow(
    'several providers (storage-sqlite, storage-postgres); select one with config.capabilities["storage.sql"]',
  );
  expect(unselected.providers("storage.sql")).toEqual(["storage-sqlite", "storage-postgres"]);

  const selected = createCapabilityRegistry<Caps>({ "storage.sql": "storage-postgres" });
  selected.provide("storage.sql", { kind: "sqlite" }, "storage-sqlite");
  selected.provide("storage.sql", { kind: "postgres" }, "storage-postgres");
  expect(selected.require("storage.sql")).toEqual({ kind: "postgres" });
});

test("a selection that names a non-provider is an error, even with one real provider", () => {
  const caps = createCapabilityRegistry<Caps>({ "storage.sql": "storage-postgres" });
  caps.provide("storage.sql", { kind: "sqlite" }, "storage-sqlite");

  expect(() => caps.require("storage.sql")).toThrow(
    'config selects "storage-postgres" but it is not provided by that component (provided by storage-sqlite)',
  );
});

test("a component cannot provide the same capability twice", () => {
  const caps = createCapabilityRegistry<Caps>();
  caps.provide("storage.sql", { kind: "a" }, "storage-sqlite");
  expect(() => caps.provide("storage.sql", { kind: "b" }, "storage-sqlite")).toThrow("provided it twice");
  expect(caps.names()).toEqual(["storage.sql"]);
});

test("keyed: each key has one implementation; a provider may contribute several keys", () => {
  const caps = createCapabilityRegistry<Caps, KeyedCaps>();
  caps.provideKeyed("channel.transport", "http", { channel: "http" }, "channel-http");
  caps.provideKeyed("channel.transport", "ws", { channel: "ws" }, "channel-http");
  caps.provideKeyed("channel.transport", "telegram", { channel: "telegram" }, "channel-telegram");

  const transports = caps.keyed("channel.transport");
  expect(transports.keys()).toEqual(["http", "ws", "telegram"]);
  expect(transports.get("telegram")).toEqual({ channel: "telegram" });
  expect(transports.get("sms")).toBeUndefined();
  expect(caps.mode("channel.transport")).toBe("keyed");
  expect(caps.providers("channel.transport")).toEqual(["channel-http", "channel-telegram"]);
  expect(caps.keys("channel.transport")).toEqual({ http: "channel-http", ws: "channel-http", telegram: "channel-telegram" });
  expect(caps.has("channel.transport")).toBe(true);
  expect(caps.selected("channel.transport")).toBeUndefined();

  expect(() => caps.provideKeyed("channel.transport", "http", { channel: "x" }, "channel-other")).toThrow(
    'key "http" is provided by both "channel-http" and "channel-other"',
  );
  expect(() => caps.provideKeyed("channel.transport", "", { channel: "x" }, "channel-other")).toThrow("empty key");
});

test("keyed and single modes do not mix, in either direction", () => {
  const caps = createCapabilityRegistry<Caps & KeyedCaps, Caps & KeyedCaps>();
  caps.provideKeyed("channel.transport", "http", { channel: "http" }, "channel-http");
  caps.provide("storage.sql", { kind: "sqlite" }, "storage-sqlite");

  expect(() => caps.provide("channel.transport", { channel: "x" }, "other")).toThrow(
    'capability "channel.transport" is keyed (provided by channel-http); component "other" provides it without a key',
  );
  expect(() => caps.provideKeyed("storage.sql", "k", { kind: "x" }, "other")).toThrow(
    'capability "storage.sql" is single (provided by storage-sqlite); component "other" provides it with a key',
  );
  expect(() => caps.require("channel.transport")).toThrow("is keyed; use it with useKeyed()");
  expect(() => caps.keyed("storage.sql")).toThrow("is not keyed; use it with use()");
  expect(caps.keyed("outbound.queue" as "channel.transport").keys()).toEqual([]);
});
