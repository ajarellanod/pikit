/**
 * Offered providers (SPEC §10.5), against this repository's registry: what a component brings is
 * decided by the capabilities it can use and the catalogue's `offer`, never by names.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { offeredProviders, withOffers } from "./offers.ts";
import { openRegistry } from "./registry-source.ts";

const registry = openRegistry(DEFAULT_REGISTRY);

test("a chat channel brings durable delivery, and the storage it requires; providers first", () => {
  expect(offeredProviders(registry, ["channel-telegram"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "outbound-durable", why: "required" },
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram", why: "recommended" },
  ]);
});

test("what is already installed is not offered again", () => {
  expect(offeredProviders(registry, ["channel-telegram"], ["outbound-durable", "storage-sqlite"])).toEqual([]);
  // The queue is there but not its storage: the storage is the user's to add (doctor says so).
  expect(offeredProviders(registry, ["channel-telegram"], ["outbound-durable"])).toEqual([]);
});

test("HTTP brings nothing; tools do not bring a per-agent workspace, which is a choice, not an offer", () => {
  expect(offeredProviders(registry, ["channel-http"])).toEqual([]);
  for (const tool of ["tool-read", "tool-write", "tool-edit", "tool-bash"]) expect(offeredProviders(registry, [tool])).toEqual([]);
});

test("pikit new places what a component brings right before it; the http preset brings nothing", () => {
  const http = registry.preset("http", []);
  expect(withOffers(registry, http).order).toEqual(http);

  const telegram = registry.preset("http", ["channel-telegram"]);
  const { order, installedFor } = withOffers(registry, telegram);
  const at = order.indexOf("channel-telegram");
  expect(order.slice(at - 2, at + 1)).toEqual(["storage-sqlite", "outbound-durable", "channel-telegram"]);
  expect(order.filter((c) => !telegram.includes(c))).toEqual(["storage-sqlite", "outbound-durable"]);
  expect(Object.fromEntries(installedFor)).toEqual({ "storage-sqlite": "outbound-durable", "outbound-durable": "channel-telegram" });
});
