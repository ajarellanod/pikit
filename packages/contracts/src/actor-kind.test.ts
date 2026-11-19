/**
 * `actor.kind` (SPEC C9): matching a key to its kind, the problems a host refuses, the closure of a
 * kind's owners over the capability graph, the kind's App as `defineApp` options, and the equivalence
 * suite over a small host made of these functions (what deployment-cloudflare's host does), with the
 * cases it must catch: a co-owner that does not declare, a start that calls another actor.
 */

import { expect, test } from "bun:test";
import { type AppDescription, type ComponentDefinition, defineApp, defineComponent, type KeyedHandle, silentLogger } from "@pikit/core";
import type { ActorCallHandler, ActorCallOutcome, ActorInbox, ActorInboxHandler, ActorMailbox } from "./actor.ts";
import {
  type ActorKind,
  type ActorKindDeclaration,
  actorComposition,
  actorKindDeclarations,
  actorKindOf,
  actorKindOptions,
  actorKindProblems,
  actorKinds,
} from "./actor-kind.ts";
import type { JsonValue } from "./json.ts";
import { type ActorKindFixture, type ActorKindObject, createActorKindConformance, withoutActorKinds } from "./testing/actor-kind.ts";

declare module "@pikit/core" {
  interface AppCapabilities {
    "test.kind-dep": object;
    "test.kind-deep": object;
    "test.kind-optional": object;
    "test.kind-absent": object;
    "test.kind-chosen": object;
    "test.kind-store": Map<string, JsonValue>;
  }
  interface AppKeyedCapabilities {
    "test.kind-plugin": object;
  }
}

const declaration = (component: string, kind: ActorKind, provider = component): ActorKindDeclaration => ({ component, provider, ...kind });

test("a key's kind: an exact key over any prefix, the longest prefix over shorter ones, co-owners together, none for the rest", () => {
  const declarations = [
    declaration("memory-sql", { prefixes: ["memory:"] }),
    declaration("memory-people", { prefixes: ["memory:person:"] }),
    declaration("credentials-do", { keys: ["credentials-do"] }),
    declaration("memory-admin", { keys: ["memory:index"], prefixes: ["memory:"] }),
  ];
  expect(actorKindOf(declarations, "credentials-do")).toEqual({ pattern: "credentials-do", exact: true, owners: ["credentials-do"] });
  expect(actorKindOf(declarations, "memory:index")).toEqual({ pattern: "memory:index", exact: true, owners: ["memory-admin"] });
  expect(actorKindOf(declarations, "memory:space:s1")).toEqual({ pattern: "memory:", exact: false, owners: ["memory-sql", "memory-admin"] });
  expect(actorKindOf(declarations, "memory:person:u1")).toEqual({ pattern: "memory:person:", exact: false, owners: ["memory-people"] });
  // A conversation's key, a key that is only a pattern's beginning, the host's own: the whole App.
  expect(actorKindOf(declarations, "telegram:42")).toBeUndefined();
  expect(actorKindOf(declarations, "credentials")).toBeUndefined();
  expect(actorKindOf(declarations, "memory")).toBeUndefined();
  expect(actorKindOf([declaration("bad", { prefixes: ["pikit:"] })], "pikit:health")).toBeUndefined();

  expect(actorKinds(declarations)).toEqual([
    { pattern: "credentials-do", exact: true, owners: ["credentials-do"] },
    { pattern: "memory:index", exact: true, owners: ["memory-admin"] },
    { pattern: "memory:", exact: false, owners: ["memory-sql", "memory-admin"] },
    { pattern: "memory:person:", exact: false, owners: ["memory-people"] },
  ]);
});

test("refused: a declaration under another component's name, an empty kind or pattern, the host's own keys, a pattern list that is not one", () => {
  expect(actorKindProblems([declaration("memory-sql", { prefixes: ["memory:"] }), declaration("credentials-do", { keys: ["credentials-do"] })])).toEqual([]);
  expect(actorKindProblems([declaration("memory-sql", { prefixes: ["memory:"] }, "memory-recall")])).toEqual([
    'actor.kind "memory-sql": provided by "memory-recall": a component declares its kinds under its own name (provideKeyed("actor.kind", "memory-recall", …))',
  ]);
  expect(actorKindProblems([declaration("a", {}), declaration("b", { keys: [], prefixes: [] })])).toEqual([
    'actor.kind "a": declares no key and no prefix',
    'actor.kind "b": declares no key and no prefix',
  ]);
  expect(actorKindProblems([declaration("c", { keys: [""], prefixes: ["pikit:"] })])).toEqual([
    'actor.kind "c": declares an empty key',
    'actor.kind "c": declares "pikit:": keys that start with "pikit:" are the deployment host\'s own',
  ]);
  expect(actorKindProblems([declaration("d", { keys: "credentials-do" as never })])).toEqual(['actor.kind "d": its keys are not a list of strings', 'actor.kind "d": declares no key and no prefix']);
});

/** Composes `components` with a reader of `actor.kind` (as the host does) and returns its description and declarations. */
async function read(components: ComponentDefinition[], config: Record<string, unknown> = {}) {
  let kinds: KeyedHandle<ActorKind> | undefined;
  const reader = defineComponent({
    name: "deployment-test",
    setup(pikit) {
      kinds = pikit.useKeyed("actor.kind");
    },
  });
  const app = await defineApp({ components: [...components, reader], config, target: "durable", logger: silentLogger }).create();
  const description = app.describe();
  return { description, declarations: actorKindDeclarations(description, kinds as KeyedHandle<ActorKind>) };
}

const provider = (name: string, provides: (pikit: Parameters<ComponentDefinition["setup"]>[0]) => void) => defineComponent({ name, setup: (pikit) => void provides(pikit) });

test("declarations are read from a created App, in its start order, each with the component that provided it", async () => {
  const late = defineComponent({
    name: "late-owner",
    setup(pikit) {
      pikit.use("test.kind-dep");
      pikit.provideKeyed("actor.kind", "late-owner", { keys: ["late"] });
    },
  });
  const early = provider("early-owner", (pikit) => {
    pikit.provide("test.kind-dep", {});
    pikit.provideKeyed("actor.kind", "early-owner", { prefixes: ["early:"] });
    // Under another's name: the host refuses it.
    pikit.provideKeyed("actor.kind", "someone-else", { keys: ["x"] });
  });
  const { declarations } = await read([late, early]);
  expect(declarations).toEqual([
    { component: "early-owner", provider: "early-owner", prefixes: ["early:"] },
    { component: "someone-else", provider: "early-owner", keys: ["x"] },
    { component: "late-owner", provider: "late-owner", keys: ["late"] },
  ]);
  expect(actorKindProblems(declarations)).toEqual([expect.stringContaining('actor.kind "someone-else": provided by "early-owner"')]);
});

/**
 * The closure's App: an owner using a required capability (whose provider uses another), an optional
 * one installed and one not, a keyed one with two providers, a single one with two providers (one
 * selected), the object's inbox and alarm, and components no owner reaches.
 */
function closureApp() {
  const owner = defineComponent({
    name: "owner",
    setup(pikit) {
      pikit.use("test.kind-dep");
      pikit.useOptional("test.kind-optional");
      pikit.useOptional("test.kind-absent");
      pikit.useKeyed("test.kind-plugin");
      pikit.use("test.kind-chosen");
      pikit.provideKeyed("actor.kind", "owner", { prefixes: ["owner:"] });
    },
  });
  return {
    components: [
      provider("conversation", (pikit) => {
        pikit.use("test.kind-dep");
        pikit.use("actor.inbox");
      }),
      owner,
      provider("dep", (pikit) => {
        pikit.provide("test.kind-dep", {});
        pikit.use("test.kind-deep");
      }),
      provider("deep", (pikit) => pikit.provide("test.kind-deep", {})),
      provider("optional", (pikit) => pikit.provide("test.kind-optional", {})),
      provider("plugin-a", (pikit) => pikit.provideKeyed("test.kind-plugin", "a", {})),
      provider("plugin-b", (pikit) => pikit.provideKeyed("test.kind-plugin", "b", {})),
      provider("chosen", (pikit) => pikit.provide("test.kind-chosen", {})),
      provider("not-chosen", (pikit) => pikit.provide("test.kind-chosen", {})),
      provider("actors", (pikit) => {
        pikit.provide("actor.inbox", {} as ActorInbox);
        pikit.provide("wakeups", {} as never);
      }),
      provider("unused", (pikit) => pikit.use("test.kind-deep")),
    ],
    config: { capabilities: { "test.kind-chosen": "chosen" } },
  };
}

test("a kind's App: the owners, what they use transitively (required, optional when installed, every keyed provider, the selected one), the inbox and alarm, in start order", async () => {
  const { components, config } = closureApp();
  const { description } = await read(components, config);
  const names = actorComposition(description, ["owner"]);
  expect([...names].sort()).toEqual(["actors", "chosen", "deep", "dep", "optional", "owner", "plugin-a", "plugin-b"]);
  // In the whole App's start order.
  expect(names).toEqual(description.components.map((c) => c.name).filter((name) => names.includes(name)));
  expect(() => actorComposition(description, ["nobody"])).toThrow('"nobody" is not a component of this App');

  // The selected peer of an included provider joins too, so the selection stays valid.
  const peer = provider("peer-user", (pikit) => pikit.provideKeyed("actor.kind", "peer-user", { keys: ["peer"] }));
  const notChosenOwner = defineComponent({
    name: "not-chosen-owner",
    setup(pikit) {
      pikit.provide("test.kind-chosen", {});
      pikit.provideKeyed("actor.kind", "not-chosen-owner", { keys: ["nc"] });
    },
  });
  const selected = await read([...components, peer, notChosenOwner], { capabilities: { "test.kind-chosen": "chosen" } });
  expect(actorComposition(selected.description, ["not-chosen-owner"])).toContain("chosen");
  expect([...actorComposition(selected.description, ["peer-user"])].sort()).toEqual(["actors", "peer-user"]);
});

test("a kind's App as defineApp options: the project's components in list order, its config and selections reduced to them; it composes as described", async () => {
  const { components, config } = closureApp();
  const { description } = await read(components, config);
  const names = actorComposition(description, ["owner"]);
  const options = actorKindOptions({ components, config }, names);
  expect(options.components.map((c) => c.name)).toEqual(components.map((c) => c.name).filter((name) => names.includes(name)));
  const app = await defineApp({ ...options, target: "durable", logger: silentLogger }).create();
  // The kernel orders it as it orders any App (providers first, list order between the rest): a
  // component the whole App started early for a consumer left out may start later here.
  const started = app.describe().components.map((c) => c.name);
  expect([...started].sort()).toEqual([...names].sort());
  expect(started.indexOf("deep")).toBeLessThan(started.indexOf("dep"));
  expect(started.indexOf("actors")).toBeGreaterThan(started.indexOf("dep"));
  expect(app.describe().capabilities["test.kind-chosen"]).toEqual({ providers: ["chosen"], selected: "chosen" });

  // The config (validated, defaulted: the definition's) keeps the included components' entries and the selections of included providers.
  const reduced = actorKindOptions(
    { components, config: { dep: { size: 5 }, unused: { on: true }, capabilities: { "test.kind-chosen": "chosen", "test.kind-deep": "unused" } } },
    names,
  );
  expect(reduced.config).toEqual({ dep: { size: 5 }, capabilities: { "test.kind-chosen": "chosen" } });
  expect(actorKindOptions({ components, config: { capabilities: { "test.kind-deep": "unused" } } }, names).config).toEqual({});
  expect(() => actorKindOptions({ components, config }, ["owner", "ghost"])).toThrow('"ghost" not among');
});

// ---- The equivalence suite over a small host made of these functions ----

/**
 * The App of the suite's fixture: an inbox that answers through the object's handlers, a store of the
 * object's own, a counter that owns the keys `counter:` (declared), a conversation whose start calls
 * another actor (as runtime-pi's start read the credentials), and, when asked, a co-owner that
 * answers on the counter's keys without declaring them.
 */
function fixtureApp(options: { coOwner?: boolean; ownerCallsAtStart?: boolean } = {}) {
  const live = { calls: new Map<string, ActorCallHandler>(), messages: new Map<string, ActorInboxHandler>(), reached: [] as string[], store: new Map<string, JsonValue>() };
  const inbox: ActorInbox = {
    scope: "one",
    handle: (type, handler) => void live.messages.set(type, handler),
    answer: (type, handler) => void live.calls.set(type, handler),
    answerStream: () => {},
  };
  const mailbox = {
    send: async (key: string) => void live.reached.push(key),
    call: async (key: string) => (live.reached.push(key), null),
    stream: async () => {
      throw new Error("no streams here");
    },
  } as ActorMailbox;
  const actors = provider("actors", (pikit) => {
    pikit.provide("actor.inbox", inbox);
    pikit.provide("actor.mailbox", mailbox);
  });
  const store = provider("store", (pikit) => pikit.provide("test.kind-store", live.store));
  const counter = defineComponent({
    name: "counter",
    setup(pikit) {
      const rows = pikit.use("test.kind-store");
      const actorInbox = pikit.use("actor.inbox");
      const actorMailbox = pikit.use("actor.mailbox");
      pikit.provideKeyed("actor.kind", "counter", { prefixes: ["counter:"] });
      return {
        async start(ctx) {
          if (options.ownerCallsAtStart === true) await actorMailbox.get().call("elsewhere", "x", null, ctx);
          actorInbox.get().answer("counter.add", async (key, message) => {
            const count = ((rows.get().get(key) as number | undefined) ?? 0) + (message as number);
            rows.get().set(key, count);
            return count;
          });
          actorInbox.get().handle("counter.reset", async (key) => void rows.get().set(key, 0));
        },
      };
    },
  });
  const conversation = defineComponent({
    name: "conversation",
    setup(pikit) {
      const actorMailbox = pikit.use("actor.mailbox");
      pikit.use("actor.inbox");
      return { start: async (ctx) => void (await actorMailbox.get().call("credentials", "read", null, ctx)) };
    },
  });
  const coOwner = defineComponent({
    name: "co-owner",
    setup(pikit) {
      const actorInbox = pikit.use("actor.inbox");
      return { start: () => actorInbox.get().answer("counter.label", async (key) => `counter ${key}`) };
    },
  });
  return { live, components: [actors, store, conversation, counter, ...(options.coOwner === true ? [coOwner] : [])] };
}

/** Opens the key's object as a host would: the whole App, or its kind's, by the functions above. */
function fixture(options: Parameters<typeof fixtureApp>[0] & { steps?: ActorKindFixture["steps"] } = {}): ActorKindFixture {
  const key = "counter:1";
  return {
    key,
    steps: options.steps ?? [
      { call: "counter.add", message: 2 },
      { send: "counter.reset", message: null },
      { call: "counter.add", message: 5 },
      { call: "counter.label", message: null },
      { call: "counter.unknown", message: null },
    ],
    async open(which): Promise<ActorKindObject> {
      const { live, components } = fixtureApp(options);
      let list: ComponentDefinition[] = withoutActorKinds(components);
      if (which === "kind") {
        const { description, declarations } = await read(components);
        const kind = actorKindOf(declarations, key);
        if (kind === undefined) throw new Error("no kind");
        list = actorKindOptions({ components, config: {} }, actorComposition(description, kind.owners)).components;
      }
      const app = await defineApp({ components: list, target: "durable", logger: silentLogger }).create();
      await app.start();
      const startCalls = [...live.reached];
      const ctx = app.context();
      return {
        async send(type, message) {
          const handler = live.messages.get(type);
          if (handler === undefined) throw new Error(`no handler for ${type}`);
          await handler(key, message, ctx);
        },
        async call(type, message): Promise<ActorCallOutcome> {
          const handler = live.calls.get(type);
          if (handler === undefined) return { ok: false, code: "no_handler", message: type };
          return { ok: true, answer: await handler(key, message, ctx) };
        },
        rows: async () => Object.fromEntries(live.store),
        startCalls: () => startCalls,
        close: () => app.stop(),
      };
    },
  };
}

const OWN_STEPS: ActorKindFixture["steps"] = [
  { call: "counter.add", message: 2 },
  { send: "counter.reset", message: null },
  { call: "counter.add", message: 5 },
  { send: "counter.unknown", message: null },
  { call: "counter.unknown", message: null },
];
for (const c of createActorKindConformance(() => fixture({ steps: OWN_STEPS }))) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

test("the suite catches a co-owner that does not declare: its call is answered in the whole App, no_handler in the kind's", async () => {
  const [same] = createActorKindConformance(() => fixture({ coOwner: true }));
  await expect(same?.run() as Promise<void>).rejects.toThrow(/the call "counter.label" \(step 4\) on "counter:1": the whole App gave .*"ok":true.*, the kind's .*no_handler/);
});

test("the suite catches a kind's start that calls another actor, and an object that stores differently", async () => {
  const [, , quiet] = createActorKindConformance(() => fixture({ ownerCallsAtStart: true }));
  await expect(quiet?.run() as Promise<void>).rejects.toThrow(/the kind's start of "counter:1" reached 1 other actor/);

  // Not reached otherwise: the conversation's call stays in the whole App.
  const [, , calm] = createActorKindConformance(() => fixture());
  await calm?.run();

  const base = fixture();
  const [, rows] = createActorKindConformance(() => ({
    ...base,
    async open(which) {
      const object = await base.open(which);
      return which === "kind" ? { ...object, rows: async () => ({}) } : object;
    },
  }));
  await expect(rows?.run() as Promise<void>).rejects.toThrow(/the whole App stored \{"counter:1":5\}, the kind's \{\}/);
});

test("the description a kind's object carries is its own App's: what K13 shows the dashboard", async () => {
  const { components } = fixtureApp();
  const { description, declarations } = await read(components);
  const kind = actorKindOf(declarations, "counter:9");
  const names = actorComposition(description, kind?.owners ?? []);
  const app = await defineApp({ ...actorKindOptions({ components, config: {} }, names), target: "durable", logger: silentLogger }).create();
  const own: AppDescription = app.describe();
  expect(own.components.map((c) => c.name)).toEqual(["actors", "store", "counter"]);
  expect(own.capabilities["actor.kind"]?.keys).toEqual({ counter: "counter" });
});
