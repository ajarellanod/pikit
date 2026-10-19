/**
 * Offered providers (`offers.ts`), against this repository's registry: what a component brings is
 * decided by the capabilities it can use and the catalogue's `offer`, never by names.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { declaredByApp } from "./apps.ts";
import { dependencyOrder, offeredProviders, type ProvidedCapabilities, providedByApp, providedByManifests, rehomedOffer, unchosenProviders, withOffers } from "./offers.ts";
import type { ProbeResult } from "./probe.ts";
import { openRegistry, type Registry } from "./registry-source.ts";

const registry = openRegistry(DEFAULT_REGISTRY);

/** What `installed` provide when they compose as their manifests in `from` say: a project's `providedByApp`, for these tests. */
const composing = (installed: readonly string[], targets: readonly string[] = ["server"], from: Registry = registry): ProvidedCapabilities =>
  providedByManifests(installed.map((name) => from.manifest(name)), targets);

test("a chat channel brings a place for its cursor (required), durable delivery, and the storage and timers they require; providers first", () => {
  expect(offeredProviders(registry, ["channel-telegram"])).toEqual([
    { component: "storage-sqlite", capability: "storage.sql", for: "storage-kv-sql", why: "required" },
    { component: "storage-kv-sql", capability: "storage.kv", for: "channel-telegram", why: "required" },
    { component: "wakeups-timers", capability: "wakeups", for: "outbound-durable", why: "required" },
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram", why: "recommended" },
  ]);
});

test("what is already installed is not offered again", () => {
  const all = ["outbound-durable", "storage-sqlite", "storage-kv-sql"];
  expect(offeredProviders(registry, ["channel-telegram"], all, ["server"], composing(all))).toEqual([]);
  // The queue and the key-value store are there but not their storage: the storage is the user's to add (doctor says so).
  const some = ["outbound-durable", "storage-kv-sql"];
  expect(offeredProviders(registry, ["channel-telegram"], some, ["server"], composing(some))).toEqual([]);
});

test("HTTP brings nothing (its GET reads the runtime's record of submissions); tools do not bring a per-agent workspace, which is a choice, not an offer", () => {
  expect(offeredProviders(registry, ["channel-http"])).toEqual([]);
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
  // What it requires and the catalogue does not mark offer (the runtime) stays the user's choice.
  expect(offeredProviders(registry, ["conversations-kv"]).map((o) => o.capability)).not.toContain("agent.conversations");
});

test("the runtime brings nothing: it provides the record of submissions itself, and its storage is the user's choice", () => {
  expect(offeredProviders(registry, ["runtime-pi"])).toEqual([]);
});

test("only providers that run on the project's targets are offered: on Cloudflare, the storage is storage-do", () => {
  // storage-sqlite does not run on Cloudflare, so storage-do is the one provider of storage.sql there.
  expect(offeredProviders(registry, ["conversations-kv"], [], ["durable"])).toEqual([
    { component: "storage-do", capability: "storage.sql", for: "storage-kv-sql", why: "required" },
    { component: "storage-kv-sql", capability: "storage.kv", for: "conversations-kv", why: "required" },
  ]);
});

test("on Cloudflare the Telegram webhook's object half brings durable delivery (the runtime provides the record of submissions); its Worker half nothing of the object's", () => {
  const preset = ["actors-do", "storage-do", "storage-kv-sql", "deployment-cloudflare", "runtime-pi", "conversations-kv"];
  expect(offeredProviders(registry, ["channel-telegram-webhook"], preset, ["durable"], composing(preset, ["durable"]))).toEqual([
    { component: "outbound-durable", capability: "outbound.queue", for: "channel-telegram-webhook", why: "recommended" },
  ]);
});

test("each half declares in its own App; a component in both Apps declares its whole in each; a server project has one App", () => {
  const webhook = registry.manifest("channel-telegram-webhook");
  const [objectHalf, workerHalf] = declaredByApp(webhook, ["durable"]);
  expect(objectHalf?.[0]).toBe("default");
  expect(objectHalf?.[1].requires).not.toContain("actor.mailbox");
  expect(workerHalf).toEqual(["worker", { provides: ["http.route"], requires: ["secrets", "actor.mailbox"], optional: [] }]);
  expect(declaredByApp(registry.manifest("secrets-workers"), ["durable"])).toEqual([
    ["default", { provides: ["secrets"], requires: [], optional: [] }],
    ["worker", { provides: ["secrets"], requires: [], optional: [] }],
  ]);
  expect(declaredByApp(registry.manifest("storage-do"), ["durable"]).map(([app]) => app)).toEqual(["default"]);
  // On a server only the default export is listed: its own half, not the Worker's needs (admin-api's actor.mailbox).
  const admin = registry.manifest("admin-api");
  expect(declaredByApp(admin, ["server"])).toEqual([["default", admin.halves?.default as NonNullable<typeof admin.halves>["default"]]]);
  expect(declaredByApp(admin, ["server"])[0]?.[1].requires).not.toContain("actor.mailbox");
  expect(declaredByApp(registry.manifest("secrets-workers"), ["server"])).toEqual([["default", { provides: ["secrets"], requires: [], optional: [] }]]);
});

/** A registry of these manifests only (targets durable), for what the repository's cannot show yet. */
function fakeRegistry(manifests: Partial<Manifest>[]): Registry {
  const full = manifests.map((m) => ({ version: "0.0.1", description: m.name, targets: ["durable"], requires: { pikit: "0.0.1", capabilities: [] }, optional: { capabilities: [] }, provides: [], dependencies: {}, files: [], ...m }) as Manifest);
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
  const channel = { name: "channel-x", requires: { pikit: "0.0.1", capabilities: ["storage.kv"] }, apps: { worker: "worker" }, halves: { default: half(["storage.kv"]), worker: half(["storage.kv"]) } };
  const objectOnly = fakeRegistry([channel, { name: "storage-kv-object", provides: ["storage.kv"] }]);
  expect(offeredProviders(objectOnly, ["channel-x"], [], ["durable"])).toEqual([{ component: "storage-kv-object", capability: "storage.kv", for: "channel-x", why: "required" }]);
  // Installed already, it still does not serve the Worker's App: nothing there to offer, `pikit add` warns.
  expect(offeredProviders(objectOnly, ["channel-x"], ["storage-kv-object"], ["durable"], composing(["storage-kv-object"], ["durable"], objectOnly))).toEqual([]);

  // A provider in both Apps serves each; offered once. One only in the Worker's is offered for the Worker's half.
  const both = fakeRegistry([channel, { name: "storage-kv-both", provides: ["storage.kv"], apps: { worker: "default" } }]);
  expect(offeredProviders(both, ["channel-x"], [], ["durable"])).toEqual([{ component: "storage-kv-both", capability: "storage.kv", for: "channel-x", why: "required" }]);
  const workerOnly = fakeRegistry([
    channel,
    { name: "storage-kv-object", provides: ["storage.kv"] },
    { name: "storage-kv-edge", provides: ["storage.kv"], apps: { worker: "worker" }, halves: { default: half([]), worker: { provides: ["storage.kv"], requires: [], optional: [] } } },
  ]);
  expect(offeredProviders(workerOnly, ["channel-x"], ["storage-kv-object"], ["durable"], composing(["storage-kv-object"], ["durable"], workerOnly))).toEqual([
    { component: "storage-kv-edge", capability: "storage.kv", for: "channel-x", why: "required", app: "worker" },
  ]);
});

test("with a second provider, nothing is offered for it (the user's choice); the presets named their storage and key-value store, and bring the rest over them", () => {
  const sqlite = registry.manifest("storage-sqlite");
  const two = { ...registry, names: () => [...registry.names(), "storage-postgres"], manifest: (name: string) => (name === "storage-postgres" ? { ...sqlite, name, provides: ["storage.sql"] } : registry.manifest(name)) } as Registry;
  expect(offeredProviders(two, ["conversations-kv"]).map((o) => o.component)).toEqual(["storage-kv-sql"]);
  const telegram = registry.preset("telegram");
  expect(withOffers(two, telegram, ["server"]).order.filter((c) => !telegram.includes(c))).toEqual(["wakeups-timers", "outbound-durable"]);
});

test("an optional capability with two providers is not offered, and is named as the user's choice instead of left out in silence", () => {
  const durable = registry.manifest("outbound-durable");
  const two = { ...registry, names: () => [...registry.names(), "outbound-other"], manifest: (name: string) => (name === "outbound-other" ? { ...durable, name } : registry.manifest(name)) } as Registry;
  expect(offeredProviders(two, ["channel-telegram"], [], ["server"]).map((o) => o.component)).not.toContain("outbound-durable");
  expect(unchosenProviders(two, ["channel-telegram"], [], ["server"])).toEqual([{ capability: "outbound.queue", why: "recommended", for: "channel-telegram", providers: ["outbound-durable", "outbound-other"] }]);
  // One provider: offered, nothing to choose. Installed already: nothing either way.
  expect(unchosenProviders(registry, ["channel-telegram"], [], ["server"])).toEqual([]);
  expect(unchosenProviders(two, ["channel-telegram"], ["outbound-other"], ["server"], composing(["outbound-other"], ["server"], two))).toEqual([]);
});

test("a required capability with two providers is named with its candidates too: until one is installed the project does not compose", () => {
  const sqlite = registry.manifest("storage-sqlite");
  const two = { ...registry, names: () => [...registry.names(), "storage-postgres"], manifest: (name: string) => (name === "storage-postgres" ? { ...sqlite, name, provides: ["storage.sql"] } : registry.manifest(name)) } as Registry;
  // The key-value store needs storage.sql, which two components provide: none comes, both named.
  expect(offeredProviders(two, ["conversations-kv"], [], ["server"]).map((o) => o.component)).toEqual(["storage-kv-sql"]);
  expect(unchosenProviders(two, ["conversations-kv"], [], ["server"])).toEqual([
    { capability: "storage.sql", why: "required", for: "storage-kv-sql", providers: ["storage-sqlite", "storage-postgres"] },
  ]);
});

test("a narrow capability's one provider is brought, and serves the portable one it provides too: providers first, nothing left to choose", () => {
  // As storage.sqlite (SQLite's dialect) beside storage.sql: the outbox needs the narrow one, which only
  // the SQLite provider has; the key-value store the portable one, which a Postgres provider has too.
  const kv = { name: "storage-kv-x", targets: ["server"], provides: ["storage.kv"], requires: { pikit: "0.0.1", capabilities: ["storage.sql"] } };
  const outbox = { name: "outbound-x", targets: ["server"], provides: ["outbound.queue"], requires: { pikit: "0.0.1", capabilities: ["storage.sqlite"] } };
  const channel = { name: "channel-x", targets: ["server"], requires: { pikit: "0.0.1", capabilities: ["storage.kv"] }, optional: { capabilities: ["outbound.queue"] } };
  const sqlite = { name: "storage-lite", targets: ["server"], provides: ["storage.sql", "storage.sqlite"] };
  const postgres = { name: "storage-pg", targets: ["server"], provides: ["storage.sql"] };
  const conversations = { name: "conversations-x", targets: ["server"], requires: { pikit: "0.0.1", capabilities: ["storage.kv"] } };
  const fake = fakeRegistry([kv, outbox, channel, conversations, sqlite, postgres]);
  expect(offeredProviders(fake, ["channel-x"], [], ["server"])).toEqual([
    { component: "storage-lite", capability: "storage.sqlite", for: "outbound-x", why: "required" },
    { component: "storage-kv-x", capability: "storage.kv", for: "channel-x", why: "required" },
    { component: "outbound-x", capability: "outbound.queue", for: "channel-x", why: "recommended" },
  ]);
  expect(unchosenProviders(fake, ["channel-x"], [], ["server"])).toEqual([]);
  expect(withOffers(fake, ["channel-x"], ["server"]).order).toEqual(["storage-lite", "storage-kv-x", "outbound-x", "channel-x"]);
  // Without the outbox's need, the portable one stays the user's choice.
  expect(offeredProviders(fake, ["conversations-x"], [], ["server"]).map((o) => o.component)).toEqual(["storage-kv-x"]);
  expect(unchosenProviders(fake, ["conversations-x"], [], ["server"])).toEqual([
    { capability: "storage.sql", why: "required", for: "storage-kv-x", providers: ["storage-lite", "storage-pg"] },
  ]);
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
  expect(offeredProviders(registry, ["channel-telegram"], [], ["server"]).map((o) => o.component)).toEqual(["storage-sqlite", "storage-kv-sql", "wakeups-timers", "outbound-durable"]);
});

test("what a composed project provides, per App, without the components about to be replaced and their Worker halves", () => {
  const app = (components: [string, string[]][]) => ({
    components: components.map(([name, provides]) => ({ name, provides, requires: [], optional: [] })),
    capabilities: {},
    pipelines: {},
    config: {},
    stagesBy: {},
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
  // The preset names its storage and key-value store (`presets/http.yaml`), and the runtime provides
  // the record of submissions: nothing is brought.
  const http = registry.preset("http", []);
  expect(http).toContain("storage-sqlite");
  expect(http).toContain("storage-kv-sql");
  // The neutral conversation registry (SPEC C5), after the runtime that creates its conversations.
  expect(http).toContain("conversations-kv");
  expect(http).not.toContain("conversations-file");
  expect(http.indexOf("runtime-pi")).toBeLessThan(http.indexOf("conversations-kv"));
  const withHttp = withOffers(registry, http);
  expect(withHttp.order).toEqual(http);
  expect(Object.fromEntries(withHttp.installedFor)).toEqual({});

  // The preset's storage serves the outbox too, and its key-value store the cursor: the chat channel
  // brings only the outbox and its timers.
  const telegram = registry.preset("http", ["channel-telegram"]);
  const { order, installedFor } = withOffers(registry, telegram);
  const at = order.indexOf("channel-telegram");
  expect(order.slice(at - 2, at + 1)).toEqual(["wakeups-timers", "outbound-durable", "channel-telegram"]);
  expect(order.filter((c) => !telegram.includes(c))).toEqual(["wakeups-timers", "outbound-durable"]);
  expect(Object.fromEntries(installedFor)).toEqual({
    "outbound-durable": "channel-telegram",
    "wakeups-timers": "outbound-durable",
  });
});

test("several names install providers first, by what each declares; otherwise in the order named", () => {
  const order = (names: string[]) => dependencyOrder(names.map((name) => registry.manifest(name)), ["server"]);
  expect(order(["channel-telegram", "storage-kv-sql", "storage-sqlite"])).toEqual(["storage-sqlite", "storage-kv-sql", "channel-telegram"]);
  expect(order(["conversations-kv", "storage-sqlite", "storage-kv-sql"])).toEqual(["storage-sqlite", "storage-kv-sql", "conversations-kv"]);
  expect(order(["tool-read", "log-events", "tool-bash"])).toEqual(["tool-read", "log-events", "tool-bash"]);
});

/** memory.store, a contract a registry's component declares (`declares.capabilities`), not the kit's. */
const MEMORY = { mode: "single", stability: "experimental", summary: "What the agent remembers of a person." };

test("a capability a registry declares resolves as the kit's: an offered component that requires it brings its one provider, on the targets, in its App", () => {
  const half = (provides: string[], requires: string[] = []) => ({ provides, requires, optional: [] });
  const channel = { name: "channel-x", optional: { capabilities: ["outbound.queue"] } };
  // The outbox requires memory.store, in its object's half only.
  const outbox = { name: "outbound-x", provides: ["outbound.queue"], requires: { pikit: "0.0.1", capabilities: ["memory.store"] } };
  const memory = { name: "memory-sql", provides: ["memory.store"], declares: { kinds: ["memory"], capabilities: { "memory.store": MEMORY } } };
  const one = fakeRegistry([channel, outbox, memory]);
  expect(offeredProviders(one, ["channel-x"], [], ["durable"])).toEqual([
    { component: "memory-sql", capability: "memory.store", for: "outbound-x", why: "required" },
    { component: "outbound-x", capability: "outbound.queue", for: "channel-x", why: "recommended" },
  ]);
  expect(withOffers(one, ["channel-x"], ["durable"]).order).toEqual(["memory-sql", "outbound-x", "channel-x"]);

  // Two providers: none comes, both named.
  const two = fakeRegistry([channel, outbox, memory, { name: "memory-kv", provides: ["memory.store"], declares: { capabilities: { "memory.store": MEMORY } } }]);
  expect(offeredProviders(two, ["channel-x"], [], ["durable"]).map((o) => o.component)).toEqual(["outbound-x"]);
  expect(unchosenProviders(two, ["channel-x"], [], ["durable"])).toEqual([{ capability: "memory.store", why: "required", for: "outbound-x", providers: ["memory-sql", "memory-kv"] }]);

  // One that does not run on the target is no candidate: the other is the one provider.
  const serverOnly = fakeRegistry([channel, outbox, memory, { name: "memory-file", targets: ["server"], provides: ["memory.store"] }]);
  expect(offeredProviders(serverOnly, ["channel-x"], [], ["durable"]).map((o) => o.component)).toEqual(["memory-sql", "outbound-x"]);
  expect(unchosenProviders(serverOnly, ["channel-x"], [], ["durable"])).toEqual([]);

  // One that provides it in the Worker's App only does not serve the object's half that needs it.
  const edge = { name: "memory-edge", provides: ["memory.store"], apps: { worker: "worker" }, halves: { default: half([]), worker: half(["memory.store"]) } };
  const apps = fakeRegistry([channel, outbox, memory, edge]);
  expect(offeredProviders(apps, ["channel-x"], [], ["durable"]).map((o) => o.component)).toEqual(["memory-sql", "outbound-x"]);
  // The Worker's half that needs it gets that one, named for its App.
  const workerOutbox = { ...outbox, apps: { worker: "worker" }, halves: { default: half(["outbound.queue"]), worker: half([], ["memory.store"]) } };
  expect(offeredProviders(fakeRegistry([channel, workerOutbox, memory, edge]), ["channel-x"], [], ["durable"])).toEqual([
    { component: "memory-edge", capability: "memory.store", for: "outbound-x", why: "required", app: "worker" },
    { component: "outbound-x", capability: "outbound.queue", for: "channel-x", why: "recommended" },
  ]);
});

test("a capability a registry declares `offer` is offered to what can use it; a keyed one, or one not marked, is not", () => {
  const tool = { name: "tool-x", optional: { capabilities: ["memory.store"] } };
  const provider = (offer: boolean, mode = "single") => ({
    name: "memory-sql",
    provides: ["memory.store"],
    declares: { kinds: ["memory"], capabilities: { "memory.store": { ...MEMORY, mode, ...(offer && { offer: true as const }) } } },
  });
  expect(offeredProviders(fakeRegistry([tool, provider(true)]), ["tool-x"], [], ["durable"])).toEqual([
    { component: "memory-sql", capability: "memory.store", for: "tool-x", why: "recommended" },
  ]);
  expect(offeredProviders(fakeRegistry([tool, provider(false)]), ["tool-x"], [], ["durable"])).toEqual([]);
  expect(offeredProviders(fakeRegistry([tool, provider(true, "keyed")]), ["tool-x"], [], ["durable"])).toEqual([]);
});

test("a provider whose component was declined stays for an accepted one that still requires what it provides, never for an optional need", () => {
  const half = (provides: string[], requires: string[] = [], optional: string[] = []) => ({ provides, requires, optional });
  const fake = fakeRegistry([
    { name: "channel-x", targets: ["server", "durable"], requires: { pikit: "0.0.1", capabilities: ["storage.kv"] }, optional: { capabilities: ["outbound.queue"] } },
    { name: "storage-kv-x", targets: ["server", "durable"], provides: ["storage.kv"], requires: { pikit: "0.0.1", capabilities: ["storage.sql"] } },
    { name: "outbound-x", targets: ["server", "durable"], provides: ["outbound.queue"], requires: { pikit: "0.0.1", capabilities: ["storage.sqlite"] } },
    { name: "storage-lite", targets: ["server", "durable"], provides: ["storage.sql", "storage.sqlite"] },
    { name: "storage-pg", targets: ["server", "durable"], provides: ["storage.sql"] },
    { name: "tool-y", targets: ["server", "durable"], optional: { capabilities: ["storage.sql"] } },
    // Requires storage.sql in its Worker half only.
    { name: "edge-x", targets: ["durable"], apps: { worker: "worker" }, halves: { default: half([]), worker: half([], ["storage.sql"]) }, requires: { pikit: "0.0.1", capabilities: ["storage.sql"] } },
    { name: "storage-both", targets: ["durable"], provides: ["storage.sql"], apps: { worker: "default" } },
  ]);
  const [sqlite, kv, outbox] = offeredProviders(fake, ["channel-x"], [], ["server"]);
  expect([sqlite?.component, kv?.component, outbox?.component]).toEqual(["storage-lite", "storage-kv-x", "outbound-x"]);
  const sqliteOffer = sqlite as NonNullable<typeof sqlite>;
  const having = (names: string[], targets = ["server"]) => providedByManifests(names.map((n) => fake.manifest(n)), targets);

  // The outbox declined, the key-value store accepted: SQLite stays, for the store's storage.sql.
  expect(rehomedOffer(fake, sqliteOffer, ["channel-x", "storage-kv-x"], ["server"], having(["channel-x", "storage-kv-x"]))).toEqual({
    component: "storage-lite", capability: "storage.sql", for: "storage-kv-x", why: "required",
  });
  // Both declined: nothing accepted needs it. Provided already: nothing to keep it for.
  expect(rehomedOffer(fake, sqliteOffer, ["channel-x"], ["server"], having(["channel-x"]))).toBeUndefined();
  expect(rehomedOffer(fake, sqliteOffer, ["channel-x", "storage-kv-x"], ["server"], having(["channel-x", "storage-kv-x", "storage-pg"]))).toBeUndefined();
  // An optional use does not bring back what was declined.
  expect(rehomedOffer(fake, sqliteOffer, ["tool-y"], ["server"], having(["tool-y"]))).toBeUndefined();

  // Per App: one only in the default App does not serve a Worker half's need; one in both does, for the Worker's App.
  const edgeNeeds = having(["edge-x"], ["durable"]);
  expect(rehomedOffer(fake, { ...sqliteOffer }, ["edge-x"], ["durable"], edgeNeeds)).toBeUndefined();
  expect(rehomedOffer(fake, { ...sqliteOffer, component: "storage-both" }, ["edge-x"], ["durable"], edgeNeeds)).toEqual({
    component: "storage-both", capability: "storage.sql", for: "edge-x", why: "required", app: "worker",
  });
});
