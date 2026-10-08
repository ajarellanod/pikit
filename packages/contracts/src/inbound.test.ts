/**
 * The inbound pipelines are typed on `AppPipelines`: a channel and a router meet on
 * them without importing each other.
 */

import { expect, test } from "bun:test";
import type { AgentRequest, AgentRuntime, ConversationRef } from "./agent.ts";
import { type ComponentDefinition, defineApp, defineComponent, halt, type Logger, silentLogger } from "@pikit/core";
import type { ConversationRegistry } from "./conversations.ts";
import { AgentUnavailableError, admitInbound, type InboundMessage } from "./inbound.ts";

const message: InboundMessage = {
  id: "m1",
  channel: "test",
  conversationId: "c1",
  actor: { id: "someone" },
  text: "hello",
  raw: { text: "hello" },
  receivedAt: 0,
};

test("a router fills in route.resolve's decision; a channel reads it", async () => {
  const router = defineComponent({
    name: "router-test",
    setup(pikit) {
      pikit.pipeline("route.resolve", (value) =>
        value.decision !== undefined ? value : { ...value, decision: { agent: "support", access: "allow" } },
      );
    },
  });
  const app = await defineApp({ components: [router], logger: silentLogger }).create();

  const resolved = await app.context().run("route.resolve", { message });

  expect(resolved).toEqual({ message, decision: { agent: "support", access: "allow" } });
});

/** The path's other ends, recording what reaches them. */
function ends() {
  const steps: string[] = [];
  const dispatched: AgentRequest[] = [];
  const conversations: ConversationRegistry = {
    async resolve(key, agent) {
      steps.push(`resolve ${key} ${agent}`);
      return { key, agent, conversationId: `conversation-of-${key}` };
    },
    get: async () => undefined,
    reset: async () => undefined,
  };
  const runtime: AgentRuntime = {
    async dispatch(request) {
      steps.push(`dispatch ${request.requestId}`);
      const seen = dispatched.some((d) => d.requestId === request.requestId);
      dispatched.push(request);
      return { kind: seen ? "duplicate" : "started", requestId: request.requestId };
    },
    abort: async () => {},
    resume: async () => {},
  };
  return { steps, dispatched, conversations, runtime };
}

/** An app with these stages (and a router to `support` unless `router` is false). */
async function appWith(stages: (pikit: Parameters<ComponentDefinition["setup"]>[0]) => void, options: { router?: boolean; logger?: Logger } = {}) {
  const components = [defineComponent({ name: "stages-test", setup: (pikit) => stages(pikit) })];
  if (options.router !== false) {
    components.push(
      defineComponent({
        name: "router-test",
        setup(pikit) {
          pikit.pipeline("route.resolve", (v) => (v.decision ? v : { ...v, decision: { agent: "support", access: "allow" } }), { priority: -100 });
        },
      }),
    );
  }
  return (await defineApp({ components, logger: options.logger ?? silentLogger }).create()).context();
}

test("admitInbound: normalized, routed, into its conversation, dispatched as the normalized text", async () => {
  const e = ends();
  const ctx = await appWith((pikit) => pikit.pipeline("inbound.normalize", (m) => ({ ...m, text: m.text.toUpperCase() })));
  const outcome = await admitInbound(ctx, message, { ...e, key: "test:c1" });

  expect(outcome).toMatchObject({ kind: "admitted", admission: { kind: "started", requestId: "m1" }, conversation: { key: "test:c1", agent: "support" } });
  expect(e.dispatched).toEqual([{ requestId: "m1", prompt: "HELLO", conversation: { key: "test:c1", agent: "support", conversationId: "conversation-of-test:c1" } }]);
});

test("admitInbound: a redelivered message is a duplicate, and runs once", async () => {
  const e = ends();
  const ctx = await appWith(() => {});
  await admitInbound(ctx, message, { ...e, key: "test:c1" });
  expect((await admitInbound(ctx, message, { ...e, key: "test:c1" })).kind).toBe("duplicate");
});

test("admitInbound: a halt names its pipeline, stage and reason, and nothing is resolved or dispatched", async () => {
  const e = ends();
  const policy = await appWith((pikit) => pikit.pipeline("inbound.normalize", () => halt("contains card data"), { id: "policy-cards" }));
  expect(await admitInbound(policy, message, { ...e, key: "test:c1" })).toEqual({
    kind: "halted",
    pipeline: "inbound.normalize",
    stage: "policy-cards",
    reason: "contains card data",
  });
  const router = await appWith((pikit) => pikit.pipeline("route.resolve", () => halt("closed"), { id: "hours", priority: 10 }));
  expect(await admitInbound(router, message, { ...e, key: "test:c1" })).toMatchObject({ kind: "halted", pipeline: "route.resolve", stage: "hours" });
  expect(e.steps).toEqual([]);
});

test("admitInbound: a deny carries its reason; no router is no_route, logged as an error", async () => {
  const e = ends();
  const deny = await appWith((pikit) =>
    pikit.pipeline("route.resolve", (v) => ({ ...v, decision: { agent: "support", access: "deny", reason: "not a customer" } }), { priority: 10 }),
  );
  expect(await admitInbound(deny, message, { ...e, key: "test:c1" })).toMatchObject({ kind: "denied", reason: "not a customer" });

  const errors: string[] = [];
  const logger: Logger = { ...silentLogger, error: (line) => void errors.push(line) };
  const none = await appWith(() => {}, { router: false, logger });
  expect(await admitInbound(none, message, { ...e, key: "test:c1" })).toMatchObject({ kind: "no_route" });
  expect(errors).toEqual(["no route.resolve stage decided: install a router (router-basic)"]);
  expect(e.steps).toEqual([]);
});

test("admitInbound: a stage that changes which message or conversation this is breaks the path", async () => {
  const e = ends();
  for (const change of [{ id: "other" }, { channel: "other" }, { conversationId: "c2" }]) {
    const ctx = await appWith((pikit) => pikit.pipeline("inbound.normalize", (m) => ({ ...m, ...change })));
    await expect(admitInbound(ctx, message, { ...e, key: "test:c1" })).rejects.toThrow("stages keep id, channel and conversationId");
  }
  expect(e.steps).toEqual([]);
});

test("admitInbound: beforeDispatch sees the conversation after it resolves and before dispatch", async () => {
  const e = ends();
  const ctx = await appWith(() => {});
  let seen: ConversationRef | undefined;
  await admitInbound(ctx, message, {
    ...e,
    key: "test:c1",
    beforeDispatch: (conversation) => {
      seen = conversation;
      e.steps.push("beforeDispatch");
    },
  });
  expect(e.steps).toEqual(["resolve test:c1 support", "beforeDispatch", "dispatch m1"]);
  expect(seen?.conversationId).toBe("conversation-of-test:c1");
});


/** A registry of one key whose conversation's agent is `retired`, and a runtime for which `retired` (and `gone`) are gone for good. */
function goneEnds(routed: string) {
  const warnings: string[] = [];
  let pointer: ConversationRef = { key: "test:c1", agent: "retired", conversationId: "c-1" };
  const dispatched: ConversationRef[] = [];
  const conversations: ConversationRegistry = {
    resolve: async () => pointer,
    get: async () => pointer,
    async reset(key, _ctx, agent) {
      const previous = pointer;
      pointer = { key, agent: agent ?? previous.agent, conversationId: `${previous.conversationId}+` };
      return { conversation: pointer, previousConversationId: previous.conversationId, newConversationId: pointer.conversationId };
    },
  };
  const runtime: AgentRuntime = {
    async dispatch(request) {
      if (["retired", "gone"].includes(request.conversation.agent)) throw new AgentUnavailableError(request.conversation.agent, "no such agent now");
      dispatched.push(request.conversation);
      return { kind: "started", requestId: request.requestId };
    },
    abort: async () => {},
    resume: async () => {},
  };
  const router = defineComponent({
    name: "router-test",
    setup: (pikit) => pikit.pipeline("route.resolve", (value) => ({ ...value, decision: { agent: routed, access: "allow" } })),
  });
  const logger: Logger = { ...silentLogger, warn: (line) => void warnings.push(line) };
  return { warnings, dispatched, conversations, runtime, router, logger, pointer: () => pointer };
}

test("a conversation whose agent is gone for good: the key moves to a new conversation of the agent routed now, and the message goes there", async () => {
  const e = goneEnds("support");
  const app = await defineApp({ components: [e.router], logger: e.logger }).create();
  const outcome = await admitInbound(app.context(), message, { conversations: e.conversations, runtime: e.runtime, key: "test:c1" });
  expect(outcome).toMatchObject({ kind: "admitted", conversation: { key: "test:c1", agent: "support", conversationId: "c-1+" } });
  expect(e.dispatched).toEqual([{ key: "test:c1", agent: "support", conversationId: "c-1+" }]);
  expect(e.warnings).toEqual(["admitInbound: the conversation's agent is no agent now; its key moves to a new conversation of the agent routed now"]);
});

test("a conversation whose agent is gone, routed to that agent still (or to another gone one): denied once, never thrown", async () => {
  for (const routed of ["retired", "gone"]) {
    const e = goneEnds(routed);
    const app = await defineApp({ components: [e.router], logger: e.logger }).create();
    const outcome = await admitInbound(app.context(), message, { conversations: e.conversations, runtime: e.runtime, key: "test:c1" });
    expect(outcome).toMatchObject({ kind: "denied", reason: expect.stringContaining("is no agent now") });
    expect(e.dispatched).toEqual([]);
  }
});

test("a plain dispatch failure (for a while) still throws: the platform delivers the message again", async () => {
  const e = goneEnds("support");
  e.runtime.dispatch = async () => {
    throw new Error("the store is down");
  };
  const app = await defineApp({ components: [e.router], logger: e.logger }).create();
  await expect(admitInbound(app.context(), message, { conversations: e.conversations, runtime: e.runtime, key: "test:c1" })).rejects.toThrow("the store is down");
  expect(e.pointer().conversationId).toBe("c-1");
});
