import { expect, test } from "bun:test";
import { createCapabilityRegistry } from "./capabilities.ts";

interface Caps {
  "storage.sql": { kind: string };
  "outbound.queue": { push(): void };
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
