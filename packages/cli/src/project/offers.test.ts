/**
 * Offered providers (SPEC §10.5), against this repository's registry: what a component brings is
 * decided by the capabilities it can use and the catalogue's `offer`, never by names.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { offeredProviders, withOffers } from "./offers.ts";
import { openRegistry } from "./registry-source.ts";

const registry = openRegistry(DEFAULT_REGISTRY);

test("a chat channel brings durable delivery, the record of submissions, a place for its cursor, and the storage they require; providers first", () => {
  expect(offeredProviders(registry, ["channel-telegram"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "outbound-durable", why: "required" },
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram", why: "recommended" },
    { component: "submissions-sql", capability: "agent.submissions", for: "channel-telegram", why: "recommended" },
    { component: "storage-kv-sql", capability: "storage.kv", for: "channel-telegram", why: "recommended" },
  ]);
});

test("what is already installed is not offered again", () => {
  expect(offeredProviders(registry, ["channel-telegram"], ["outbound-durable", "storage-sqlite", "submissions-sql", "storage-kv-sql"])).toEqual([]);
  // The queue, the record and the key-value store are there but not their storage: the storage is the user's to add (doctor says so).
  expect(offeredProviders(registry, ["channel-telegram"], ["outbound-durable", "submissions-sql", "storage-kv-sql"])).toEqual([]);
});

test("HTTP brings only the record of submissions (its GET); tools do not bring a per-agent workspace, which is a choice, not an offer", () => {
  expect(offeredProviders(registry, ["channel-http"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "submissions-sql", why: "required" },
    { component: "submissions-sql", capability: "agent.submissions", for: "channel-http", why: "recommended" },
  ]);
  for (const tool of ["tool-read", "tool-write", "tool-edit", "tool-bash"]) expect(offeredProviders(registry, [tool])).toEqual([]);
});

test("the runtime brings the record of submissions, and the storage it requires", () => {
  expect(offeredProviders(registry, ["runtime-pi"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "submissions-sql", why: "required" },
    { component: "submissions-sql", capability: "agent.submissions", for: "runtime-pi", why: "recommended" },
  ]);
});

test("only providers that run on the project's targets are offered: on Cloudflare, the storage is storage-do", () => {
  // storage-sqlite does not run on Cloudflare, so storage-do is the one provider of storage.sql there.
  expect(offeredProviders(registry, ["channel-http"], [], ["cloudflare"])).toEqual([
    { component: "storage-do", capability: "storage.sql", for: "submissions-sql", why: "required" },
    { component: "submissions-sql", capability: "agent.submissions", for: "channel-http", why: "recommended" },
  ]);
});

test("pikit new places what a component brings right before it; a provider already brought is not brought again", () => {
  const http = registry.preset("http", []);
  const withHttp = withOffers(registry, http);
  const runtime = withHttp.order.indexOf("runtime-pi");
  expect(withHttp.order.slice(runtime - 2, runtime + 1)).toEqual(["storage-sqlite", "submissions-sql", "runtime-pi"]);
  expect(withHttp.order.filter((c) => !http.includes(c))).toEqual(["storage-sqlite", "submissions-sql"]);
  expect(Object.fromEntries(withHttp.installedFor)).toEqual({ "storage-sqlite": "submissions-sql", "submissions-sql": "runtime-pi" });

  // The runtime's storage serves the outbox and the key-value store too: the chat channel brings only those two.
  const telegram = registry.preset("http", ["channel-telegram"]);
  const { order, installedFor } = withOffers(registry, telegram);
  const at = order.indexOf("channel-telegram");
  expect(order.slice(at - 2, at + 1)).toEqual(["outbound-durable", "storage-kv-sql", "channel-telegram"]);
  expect(order.filter((c) => !telegram.includes(c))).toEqual(["storage-sqlite", "submissions-sql", "outbound-durable", "storage-kv-sql"]);
  expect(Object.fromEntries(installedFor)).toEqual({
    "storage-sqlite": "submissions-sql",
    "submissions-sql": "runtime-pi",
    "outbound-durable": "channel-telegram",
    "storage-kv-sql": "channel-telegram",
  });
});
