/**
 * Offered providers (`offers.ts`), against this repository's registry: what a component brings is
 * decided by the capabilities it can use and the catalogue's `offer`, never by names.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { declaredByApp } from "./apps.ts";
import { offeredProviders, withOffers } from "./offers.ts";
import { openRegistry, type Registry } from "./registry-source.ts";

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

test("a component that requires a capability marked offer brings its provider, and the storage it requires", () => {
  expect(offeredProviders(registry, ["conversations-kv"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "storage-kv-sql", why: "required" },
    { component: "storage-kv-sql", capability: "storage.kv", for: "conversations-kv", why: "required" },
  ]);
  // The storage is there: only the key-value store comes. Both there: nothing.
  expect(offeredProviders(registry, ["conversations-kv"], ["storage-sqlite"])).toEqual([
    { component: "storage-kv-sql", capability: "storage.kv", for: "conversations-kv", why: "required" },
  ]);
  expect(offeredProviders(registry, ["conversations-kv"], ["storage-sqlite", "storage-kv-sql"])).toEqual([]);
  // What it requires and the catalogue does not mark offer (its sessions) stays the user's choice.
  expect(offeredProviders(registry, ["conversations-kv"]).map((o) => o.capability)).not.toContain("sessions.store");
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

test("on Cloudflare the Telegram webhook's object half brings the record of submissions and durable delivery; its Worker half nothing of the object's", () => {
  const preset = ["storage-do", "sessions-sql", "conversations-kv", "storage-kv-sql", "deployment-cloudflare"];
  expect(offeredProviders(registry, ["channel-telegram-webhook"], preset, ["cloudflare"])).toEqual([
    { component: "submissions-sql", capability: "agent.submissions", for: "channel-telegram-webhook", why: "required" },
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram-webhook", why: "recommended" },
  ]);
});

test("each half declares in its own App; a component in both Apps declares its whole in each; a server project has one App", () => {
  const webhook = registry.manifest("channel-telegram-webhook");
  const [objectHalf, workerHalf] = declaredByApp(webhook, ["cloudflare"]);
  expect(objectHalf?.[0]).toBe("default");
  expect(objectHalf?.[1].requires).not.toContain("actor.mailbox");
  expect(workerHalf).toEqual(["worker", { provides: ["http.route"], requires: ["secrets", "actor.mailbox"], optional: [] }]);
  expect(declaredByApp(registry.manifest("secrets-cloudflare"), ["cloudflare"])).toEqual([
    ["default", { provides: ["secrets"], requires: [], optional: [] }],
    ["worker", { provides: ["secrets"], requires: [], optional: [] }],
  ]);
  expect(declaredByApp(registry.manifest("storage-do"), ["cloudflare"]).map(([app]) => app)).toEqual(["default"]);
  expect(declaredByApp(webhook, ["server"])).toEqual([["default", { provides: webhook.provides, requires: webhook.requires.capabilities, optional: webhook.optional.capabilities }]]);
});

/** A registry of these manifests only (targets cloudflare), for what the repository's cannot show yet. */
function fakeRegistry(manifests: Partial<Manifest>[]): Registry {
  const full = manifests.map((m) => ({ version: "0.0.0", description: m.name, targets: ["cloudflare"], requires: { pikit: "0.0.0", capabilities: [] }, optional: { capabilities: [] }, provides: [], dependencies: {}, files: [], ...m }) as Manifest);
  return {
    names: () => full.map((m) => m.name),
    manifest: (name: string) => {
      const found = full.find((m) => m.name === name);
      if (found === undefined) throw new Error(`no component "${name}"`);
      return found;
    },
  } as unknown as Registry;
}

test("a provider is offered in the App that misses it: one that goes only in the object's App does not serve the Worker's", () => {
  const half = (requires: string[]) => ({ provides: [], requires, optional: [] });
  const channel = { name: "channel-x", requires: { pikit: "0.0.0", capabilities: ["storage.kv"] }, apps: { worker: "worker" }, halves: { default: half(["storage.kv"]), worker: half(["storage.kv"]) } };
  const objectOnly = fakeRegistry([channel, { name: "storage-kv-object", provides: ["storage.kv"] }]);
  expect(offeredProviders(objectOnly, ["channel-x"], [], ["cloudflare"])).toEqual([{ component: "storage-kv-object", capability: "storage.kv", for: "channel-x", why: "required" }]);
  // Installed already, it still does not serve the Worker's App: nothing there to offer, `pikit add` warns.
  expect(offeredProviders(objectOnly, ["channel-x"], ["storage-kv-object"], ["cloudflare"])).toEqual([]);

  // A provider in both Apps serves each; offered once. One only in the Worker's is offered for the Worker's half.
  const both = fakeRegistry([channel, { name: "storage-kv-both", provides: ["storage.kv"], apps: { worker: "default" } }]);
  expect(offeredProviders(both, ["channel-x"], [], ["cloudflare"])).toEqual([{ component: "storage-kv-both", capability: "storage.kv", for: "channel-x", why: "required" }]);
  const workerOnly = fakeRegistry([
    channel,
    { name: "storage-kv-object", provides: ["storage.kv"] },
    { name: "storage-kv-edge", provides: ["storage.kv"], apps: { worker: "worker" }, halves: { default: half([]), worker: { provides: ["storage.kv"], requires: [], optional: [] } } },
  ]);
  expect(offeredProviders(workerOnly, ["channel-x"], ["storage-kv-object"], ["cloudflare"])).toEqual([
    { component: "storage-kv-edge", capability: "storage.kv", for: "channel-x", why: "required", app: "worker" },
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
