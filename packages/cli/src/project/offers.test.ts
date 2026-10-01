/**
 * Offered providers (`offers.ts`), against this repository's registry: what a component brings is
 * decided by the capabilities it can use and the catalogue's `offer`, never by names.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { declaredByApp } from "./apps.ts";
import { offeredProviders, type ProvidedCapabilities, providedByApp, providedByManifests, unchosenProviders, withOffers } from "./offers.ts";
import type { ProbeResult } from "./probe.ts";
import { openRegistry, type Registry } from "./registry-source.ts";

const registry = openRegistry(DEFAULT_REGISTRY);

/** What `installed` provide when they compose as their manifests in `from` say: a project's `providedByApp`, for these tests. */
const composing = (installed: readonly string[], targets: readonly string[] = ["server"], from: Registry = registry): ProvidedCapabilities =>
  providedByManifests(installed.map((name) => from.manifest(name)), targets);

test("a chat channel brings durable delivery, the record of submissions, a place for its cursor, and the storage they require; providers first", () => {
  expect(offeredProviders(registry, ["channel-telegram"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "outbound-durable", why: "required" },
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram", why: "recommended" },
    { component: "submissions-sql", capability: "agent.submissions", for: "channel-telegram", why: "recommended" },
    { component: "storage-kv-sql", capability: "storage.kv", for: "channel-telegram", why: "recommended" },
  ]);
});

test("what is already installed is not offered again", () => {
  const all = ["outbound-durable", "storage-sqlite", "submissions-sql", "storage-kv-sql"];
  expect(offeredProviders(registry, ["channel-telegram"], all, ["server"], composing(all))).toEqual([]);
  // The queue, the record and the key-value store are there but not their storage: the storage is the user's to add (doctor says so).
  const some = ["outbound-durable", "submissions-sql", "storage-kv-sql"];
  expect(offeredProviders(registry, ["channel-telegram"], some, ["server"], composing(some))).toEqual([]);
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
  expect(offeredProviders(registry, ["conversations-kv"], ["storage-sqlite"], ["server"], composing(["storage-sqlite"]))).toEqual([
    { component: "storage-kv-sql", capability: "storage.kv", for: "conversations-kv", why: "required" },
  ]);
  expect(offeredProviders(registry, ["conversations-kv"], ["storage-sqlite", "storage-kv-sql"], ["server"], composing(["storage-sqlite", "storage-kv-sql"]))).toEqual([]);
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
  expect(offeredProviders(registry, ["channel-telegram-webhook"], preset, ["cloudflare"], composing(preset, ["cloudflare"]))).toEqual([
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
  expect(offeredProviders(objectOnly, ["channel-x"], ["storage-kv-object"], ["cloudflare"], composing(["storage-kv-object"], ["cloudflare"], objectOnly))).toEqual([]);

  // A provider in both Apps serves each; offered once. One only in the Worker's is offered for the Worker's half.
  const both = fakeRegistry([channel, { name: "storage-kv-both", provides: ["storage.kv"], apps: { worker: "default" } }]);
  expect(offeredProviders(both, ["channel-x"], [], ["cloudflare"])).toEqual([{ component: "storage-kv-both", capability: "storage.kv", for: "channel-x", why: "required" }]);
  const workerOnly = fakeRegistry([
    channel,
    { name: "storage-kv-object", provides: ["storage.kv"] },
    { name: "storage-kv-edge", provides: ["storage.kv"], apps: { worker: "worker" }, halves: { default: half([]), worker: { provides: ["storage.kv"], requires: [], optional: [] } } },
  ]);
  expect(offeredProviders(workerOnly, ["channel-x"], ["storage-kv-object"], ["cloudflare"], composing(["storage-kv-object"], ["cloudflare"], workerOnly))).toEqual([
    { component: "storage-kv-edge", capability: "storage.kv", for: "channel-x", why: "required", app: "worker" },
  ]);
});

test("with a second provider, nothing is offered for it (the user's choice); the presets named their storage, and bring the rest over it", () => {
  const sqlite = registry.manifest("storage-sqlite");
  const two = { ...registry, names: () => [...registry.names(), "storage-postgres"], manifest: (name: string) => (name === "storage-postgres" ? { ...sqlite, name } : registry.manifest(name)) } as Registry;
  expect(offeredProviders(two, ["channel-http"]).map((o) => o.component)).toEqual(["submissions-sql"]);
  const telegram = registry.preset("telegram");
  expect(withOffers(two, telegram, ["server"]).order.filter((c) => !telegram.includes(c))).toEqual(["submissions-sql", "outbound-durable", "storage-kv-sql"]);
});

test("an optional capability with two providers is not offered, and is named as the user's choice instead of left out in silence", () => {
  const durable = registry.manifest("outbound-durable");
  const two = { ...registry, names: () => [...registry.names(), "outbound-other"], manifest: (name: string) => (name === "outbound-other" ? { ...durable, name } : registry.manifest(name)) } as Registry;
  expect(offeredProviders(two, ["channel-telegram"], [], ["server"]).map((o) => o.component)).not.toContain("outbound-durable");
  expect(unchosenProviders(two, ["channel-telegram"], [], ["server"])).toEqual([{ capability: "outbound.queue", for: "channel-telegram", providers: ["outbound-durable", "outbound-other"] }]);
  // One provider: offered, nothing to choose. Installed already: nothing either way.
  expect(unchosenProviders(registry, ["channel-telegram"], [], ["server"])).toEqual([]);
  expect(unchosenProviders(two, ["channel-telegram"], ["outbound-other"], ["server"], composing(["outbound-other"], ["server"], two))).toEqual([]);
});

test("what an installed component provides is what the project composes, not what a registry's component of that name declares", () => {
  // `outbound-a` is installed from another registry, and its code provides nothing; this registry's
  // `outbound-a` says it provides the queue. The queue is offered all the same, by the one provider
  // that is not an installed name: an installed one is never reinstalled.
  const channel = { name: "channel-x", targets: ["server"], optional: { capabilities: ["outbound.queue"] } };
  const provider = (name: string) => ({ name, targets: ["server"], provides: ["outbound.queue"] });
  const other = fakeRegistry([channel, provider("outbound-a"), provider("outbound-b")]);
  const nothing: ProvidedCapabilities = { default: new Set(), worker: new Set() };
  expect(offeredProviders(other, ["channel-x"], ["outbound-a"], ["server"], nothing)).toEqual([
    { component: "outbound-b", capability: "outbound.queue", for: "channel-x", why: "recommended" },
  ]);
  expect(unchosenProviders(other, ["channel-x"], ["outbound-a"], ["server"], nothing)).toEqual([]);
  // Composed with the queue (the project's own component, or its config), nothing is offered.
  const queued: ProvidedCapabilities = { default: new Set(["outbound.queue"]), worker: new Set() };
  expect(offeredProviders(other, ["channel-x"], ["outbound-a"], ["server"], queued)).toEqual([]);
});

test("with something installed and the composition unknown, nothing is offered nor named: never guessed from manifests", () => {
  expect(offeredProviders(registry, ["channel-telegram"], ["tool-bash"], ["server"])).toEqual([]);
  expect(unchosenProviders(registry, ["channel-telegram"], ["tool-bash"], ["server"])).toEqual([]);
  // Nothing installed (a new project): the manifests are all there is.
  expect(offeredProviders(registry, ["channel-http"], [], ["server"]).map((o) => o.component)).toEqual(["storage-sqlite", "submissions-sql"]);
});

test("what a composed project provides, per App, without the components about to be replaced and their Worker halves", () => {
  const app = (components: [string, string[]][]) => ({
    components: components.map(([name, provides]) => ({ name, provides, requires: [], optional: [] })),
    capabilities: {},
    pipelines: {},
    config: {},
  });
  const result: ProbeResult = {
    ok: true,
    listed: [],
    agents: [],
    description: app([["agents", ["agent.definition"]], ["channel-x", ["outbound.queue"]], ["storage-x", ["storage.sql"]]]),
    worker: app([["channel-x-worker", ["http.route"]], ["secrets-x", ["secrets"]]]),
  };
  expect(providedByApp(result)).toEqual({
    default: new Set(["agent.definition", "outbound.queue", "storage.sql"]),
    worker: new Set(["http.route", "secrets"]),
  });
  expect(providedByApp(result, ["channel-x"])).toEqual({ default: new Set(["agent.definition", "storage.sql"]), worker: new Set(["secrets"]) });
  expect(providedByApp({ ok: false, error: "no" })).toBeUndefined();
});

test("pikit new places what a component brings right before it; a provider already brought is not brought again", () => {
  // The preset names its storage (`presets/http.yaml`): the runtime brings only its record of submissions.
  const http = registry.preset("http", []);
  expect(http).toContain("storage-sqlite");
  const withHttp = withOffers(registry, http);
  const runtime = withHttp.order.indexOf("runtime-pi");
  expect(withHttp.order.slice(runtime - 1, runtime + 1)).toEqual(["submissions-sql", "runtime-pi"]);
  expect(withHttp.order.filter((c) => !http.includes(c))).toEqual(["submissions-sql"]);
  expect(Object.fromEntries(withHttp.installedFor)).toEqual({ "submissions-sql": "runtime-pi" });

  // The preset's storage serves the outbox and the key-value store too: the chat channel brings only those two.
  const telegram = registry.preset("http", ["channel-telegram"]);
  const { order, installedFor } = withOffers(registry, telegram);
  const at = order.indexOf("channel-telegram");
  expect(order.slice(at - 2, at + 1)).toEqual(["outbound-durable", "storage-kv-sql", "channel-telegram"]);
  expect(order.filter((c) => !telegram.includes(c))).toEqual(["submissions-sql", "outbound-durable", "storage-kv-sql"]);
  expect(Object.fromEntries(installedFor)).toEqual({
    "submissions-sql": "runtime-pi",
    "outbound-durable": "channel-telegram",
    "storage-kv-sql": "channel-telegram",
  });
});
