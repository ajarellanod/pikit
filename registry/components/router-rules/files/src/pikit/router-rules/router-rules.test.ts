/**
 * router-rules' tests. They are copied with the component and keep running in your project.
 *
 * A component never imports another's files (SPEC P4), so `router-basic` is played by `defaultRouter`
 * below: the same stage, at the same priority (0). `settings` and `agent.directory` are doubles (a map,
 * validating against the declared schema; a list): their providers pass their suites on their own.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, Halt, silentLogger } from "@pikit/core";
import { defineAgent, type DirectoryAgent, type InboundMessage, type Settings, SettingsError, type SettingsValue } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import Value from "typebox/value";
import routerRules from "./index.ts";

const agents = defineComponent({
  name: "agents-test",
  setup(pikit) {
    for (const name of ["assistant", "support", "sales"]) pikit.provideKeyed("agent.definition", name, defineAgent({ name, model: "faux/scripted" }));
  },
});

/** What router-basic does with `defaultAgent: "assistant"`. */
const defaultRouter = defineComponent({
  name: "default-router-test",
  setup(pikit) {
    pikit.pipeline(
      "route.resolve",
      (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: "assistant", access: "allow" } }),
      { id: "router-basic", priority: 0 },
    );
  },
});

function message(fields: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", channel: "http", conversationId: "c1", actor: { id: "someone" }, text: "hello", raw: {}, receivedAt: 0, ...fields };
}

async function started(rules: unknown[], extra: ReturnType<typeof defineComponent>[] = []) {
  const app = await defineApp({ components: [agents, routerRules, ...extra], config: { "router-rules": { rules } }, logger: silentLogger }).create();
  await app.start();
  return app;
}

async function agentFor(app: Awaited<ReturnType<typeof started>>, fields: Partial<InboundMessage>) {
  const routed = await app.context().run("route.resolve", { message: message(fields) });
  if (routed instanceof Halt) throw new Error(`route.resolve halted: ${routed.reason}`);
  return routed.decision;
}

const config = { "router-rules": { rules: [{ channel: "telegram", agent: "support" }] } };

for (const c of createLifecycleConformance(() => ({ component: routerRules, providers: [agents], config }))) {
  test(`router-rules ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [agents, routerRules, defaultRouter], config, logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "router-rules")).toMatchObject({
    provides: [],
    requires: [],
    optional: ["agent.definition", "settings", "agent.directory"],
  });
  // Before router-basic, whatever order the components were listed in.
  expect(app.describe().pipelines["route.resolve"]).toEqual([
    { id: "router-rules", priority: 1 },
    { id: "router-basic", priority: 0 },
  ]);
});

test("the first rule that matches decides", async () => {
  const app = await started([
    { channel: "telegram", agent: "support" },
    { channel: "telegram", agent: "sales" },
    { agent: "sales" },
  ]);

  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "support", access: "allow" });
  expect(await agentFor(app, { channel: "http" })).toEqual({ agent: "sales", access: "allow" });
  await app.stop();
});

test("a kind matches every account of it; an instance matches only itself", async () => {
  const app = await started([
    { channel: "telegram:sales", agent: "sales" },
    { channel: "telegram", agent: "support" },
  ]);

  expect(await agentFor(app, { channel: "telegram:sales" })).toMatchObject({ agent: "sales" });
  expect(await agentFor(app, { channel: "telegram:support" })).toMatchObject({ agent: "support" });
  expect(await agentFor(app, { channel: "telegram" })).toMatchObject({ agent: "support" });
  // A kind is a whole name, not a prefix.
  expect(await agentFor(app, { channel: "telegramx" })).toBeUndefined();
  await app.stop();
});

test("conversation and actor match, and every field a rule gives must match", async () => {
  const app = await started([
    { channel: "telegram", conversation: "42", actor: "ana", agent: "sales" },
    { conversation: "42", agent: "support" },
    { actor: "ana", agent: "assistant" },
  ]);

  expect(await agentFor(app, { channel: "telegram", conversationId: "42", actor: { id: "ana" } })).toMatchObject({ agent: "sales" });
  expect(await agentFor(app, { channel: "http", conversationId: "42", actor: { id: "ana" } })).toMatchObject({ agent: "support" });
  expect(await agentFor(app, { conversationId: "7", actor: { id: "ana" } })).toMatchObject({ agent: "assistant" });
  expect(await agentFor(app, { conversationId: "7", actor: { id: "bob" } })).toBeUndefined();
  await app.stop();
});

test("a rule with no match fields matches every message", async () => {
  const app = await started([{ agent: "support" }]);

  expect(await agentFor(app, { channel: "anything:else", conversationId: "x", actor: { id: "y" } })).toMatchObject({ agent: "support" });
  await app.stop();
});

test("a deny rule denies, with its reason", async () => {
  const app = await started([{ actor: "spammer", deny: true, reason: "blocked" }, { channel: "telegram", deny: true }, { agent: "assistant" }]);

  expect(await agentFor(app, { actor: { id: "spammer" } })).toEqual({ agent: "", access: "deny", reason: "blocked" });
  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "", access: "deny" });
  expect(await agentFor(app, {})).toEqual({ agent: "assistant", access: "allow" });
  await app.stop();
});

test("a message no rule matches is left to router-basic's defaultAgent", async () => {
  const app = await started([{ channel: "telegram", agent: "support" }], [defaultRouter]);

  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "support", access: "allow" });
  expect(await agentFor(app, { channel: "http" })).toEqual({ agent: "assistant", access: "allow" });
  await app.stop();
});

test("a decision an earlier stage made is left as it is", async () => {
  const vip = defineComponent({
    name: "vip-route",
    setup(pikit) {
      pikit.pipeline(
        "route.resolve",
        (value) => (value.message.actor.id === "vip" ? { ...value, decision: { agent: "sales", access: "allow" } } : value),
        { id: "vip", priority: 10 },
      );
    },
  });
  const app = await started([{ agent: "support" }], [vip]);

  expect(await agentFor(app, { actor: { id: "vip" } })).toMatchObject({ agent: "sales" });
  expect(await agentFor(app, { actor: { id: "someone" } })).toMatchObject({ agent: "support" });
  await app.stop();
});

test("it refuses to start when a rule names an agent that does not exist", async () => {
  const app = await defineApp({
    components: [agents, routerRules],
    config: { "router-rules": { rules: [{ agent: "support" }, { channel: "telegram", agent: "billing" }, { deny: true }] } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).cause)).toContain('rules name "billing", not an agent.definition (agents: "assistant", "support", "sales")');
});

test("an invalid rule is rejected by config validation; no rules at all is valid", () => {
  const invalid = (rules: unknown) => () =>
    defineApp({ components: [agents, routerRules], config: { "router-rules": { rules } }, logger: silentLogger });

  // Just installed (`pikit add router-rules`), with no rules yet: it composes, and routes nothing.
  expect(() => defineApp({ components: [agents, routerRules], logger: silentLogger })).not.toThrow();
  expect(invalid([])).not.toThrow();
  // Exactly one of `agent` and `deny`.
  expect(invalid([{ channel: "telegram" }])).toThrow("invalid config");
  expect(invalid([{ agent: "support", deny: true }])).toThrow("invalid config");
  expect(invalid([{ deny: false }])).toThrow("invalid config");
  // An unknown match field (a typo, or `thread` before it exists) is not a catch-all.
  expect(invalid([{ chanel: "telegram", agent: "support" }])).toThrow("invalid config");
  expect(invalid([{ thread: "t1", agent: "support" }])).toThrow("invalid config");
  expect(invalid([{ channel: "", agent: "support" }])).toThrow("invalid config");
});

/** `settings` in memory, validating against what was declared. */
function memorySettings() {
  const stored = new Map<string, SettingsValue>();
  const declared = new Map<string, { schema: object; defaults: SettingsValue }>();
  const provider: Settings = {
    declare: (component, schema, defaults) => void declared.set(component, { schema, defaults }),
    async get<T extends SettingsValue>(component: string) {
      const found = declared.get(component);
      if (found === undefined) throw new SettingsError("unknown_component", component);
      return structuredClone({ ...found.defaults, ...stored.get(component) }) as T;
    },
    async set(component, value) {
      const found = declared.get(component);
      if (found === undefined) throw new SettingsError("unknown_component", component);
      if (!Value.Check(found.schema as never, { ...found.defaults, ...value })) throw new SettingsError("invalid_value", component);
      stored.set(component, structuredClone(value));
      return value;
    },
    sections: async () => [],
  };
  return { provider, component: defineComponent({ name: "settings-test", setup: (pikit) => pikit.provide("settings", provider) }) };
}

/** `agent.directory` as a list: the live agents. */
function directoryOf(agents: DirectoryAgent[]) {
  return defineComponent({
    name: "directory-test",
    setup(pikit) {
      pikit.provide("agent.directory", {
        list: async () => structuredClone(agents),
        get: async (name) => structuredClone(agents.find((agent) => agent.name === name)),
      });
    },
  });
}

test("with settings, the rules an operator sets replace the config's, from the next message; their default is the config's", async () => {
  const settings = memorySettings();
  const app = await started([{ channel: "telegram", agent: "support" }], [settings.component]);
  const ctx = app.context();

  expect(await settings.provider.get("router-rules", ctx)).toEqual({ rules: [{ channel: "telegram", agent: "support" }] });
  await settings.provider.set("router-rules", { rules: [{ channel: "telegram", agent: "sales" }, { actor: "spammer", deny: true, reason: "blocked" }] }, { id: "ops" }, ctx);
  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "sales", access: "allow" });
  expect(await agentFor(app, { channel: "http", actor: { id: "spammer" } })).toEqual({ agent: "", access: "deny", reason: "blocked" });
  // Validated as the config's: without a directory, only the code's agents; never a typo.
  await expect(settings.provider.set("router-rules", { rules: [{ agent: "billing" }] }, { id: "ops" }, ctx)).rejects.toThrow(SettingsError);
  await expect(settings.provider.set("router-rules", { rules: [{ chanel: "telegram", agent: "sales" }] }, { id: "ops" }, ctx)).rejects.toThrow(SettingsError);
  await app.stop();
});

test("settings that cannot be read leave the config's rules", async () => {
  const settings = memorySettings();
  const warnings: string[] = [];
  const app = await defineApp({
    components: [agents, settings.component, routerRules],
    config: { "router-rules": { rules: [{ channel: "telegram", agent: "support" }] } },
    logger: { ...silentLogger, warn: (line: string) => void warnings.push(line) },
  }).create();
  await app.start();
  await settings.provider.set("router-rules", { rules: [{ channel: "telegram", agent: "sales" }] }, { id: "ops" }, app.context());
  settings.provider.get = async () => {
    throw new Error("unreachable");
  };
  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "support", access: "allow" });
  expect(warnings).toEqual(["router-rules: its settings could not be read; the config's rules apply"]);
  await app.stop();
});

test("with agent.directory, a rule may name a live agent, checked when a message matches it: no agent halts the message", async () => {
  const live: DirectoryAgent[] = [{ name: "billing", model: "faux/scripted" }];
  const settings = memorySettings();
  // The config may name a live agent: start does not check it.
  const app = await started([{ channel: "telegram", agent: "billing" }], [settings.component, directoryOf(live)]);
  const ctx = app.context();

  expect(await agentFor(app, { channel: "telegram" })).toEqual({ agent: "billing", access: "allow" });
  await settings.provider.set("router-rules", { rules: [{ channel: "telegram", agent: "nobody" }] }, { id: "ops" }, ctx);
  const routed = await ctx.run("route.resolve", { message: message({ channel: "telegram" }) });
  expect(routed).toBeInstanceOf(Halt);
  expect((routed as Halt).reason).toBe('router-rules: the rule for this message names "nobody", which is no agent (neither an agent.definition nor a live agent)');
  // An agent's name is kebab-case, live or not.
  await expect(settings.provider.set("router-rules", { rules: [{ agent: "Not An Agent" }] }, { id: "ops" }, ctx)).rejects.toThrow(SettingsError);
  await app.stop();
});

test("with agent.directory, a config rule naming what can be no agent still refuses to start", async () => {
  const app = await defineApp({
    components: [agents, directoryOf([]), routerRules],
    config: { "router-rules": { rules: [{ agent: "Billing Team" }] } },
    logger: silentLogger,
  }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(String((error as Error).cause)).toContain('rules name "Billing Team", which can be no agent');
});
