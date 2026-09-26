/**
 * router-rules' tests. They are copied with the component and keep running in your project.
 *
 * A component never imports another's files (S4), so `router-basic` is played by `defaultRouter`
 * below: the same stage, at the same priority (0).
 */

import { expect, test } from "bun:test";
import { defineAgent, defineApp, defineComponent, Halt, type InboundMessage, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
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
    optional: ["agent.definition"],
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
