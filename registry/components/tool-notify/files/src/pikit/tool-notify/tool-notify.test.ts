/**
 * tool-notify's tests. They are copied with the component and keep running in your project.
 *
 * The tool is called directly, with a conversation in its context (`CONVERSATION`), as the runtime
 * gives it, in an App with the in-memory mailbox (`scope` "all": every key's actor is the App, as on a
 * server), `storage.kv` in memory, and a stand-in `outbound.queue` that stores each idempotency key
 * once and refuses a channel with no transport. Against a real outbound-durable, and through
 * runtime-pi, is `app.test.ts` beside `files/` in the registry.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { ActorCallError, type ActorMailbox, CONVERSATION, type ConversationRef, type JsonValue, type OutboundMessage, type OutboundQueue } from "@pikit/contracts";
import { createMemoryKeyValueStorage, createMemoryMailbox } from "@pikit/contracts/testing";
import type { ToolRegistration } from "@pikit/pi-adapter/tools";
import toolNotify, { ENQUEUE, NOTIFY_TOOL, notifyDescription, type NotifyConfig, TEXT_MAX } from "./index.ts";

const config: NotifyConfig = {
  destinations: {
    ops: { channel: "telegram:ops", conversation: "telegram:ops:-100123", description: "The operations group.", from: ["orchestrator", "developer"] },
    team: { channel: "googlechat", conversation: "googlechat:spaces/AAAA", description: "The team's space.", maxPerHour: 2 },
    quiet: { channel: "googlechat", conversation: "googlechat:spaces/BBBB", description: "Without names.", attribution: false },
    offline: { channel: "slack", conversation: "slack:C1", description: "No transport." },
  },
  maxPerHour: 30,
};

/** A conversation a person started, of `agent`. */
const root = (agent: string): ConversationRef => ({ key: `telegram:${agent}`, agent, conversationId: `c-${agent}` });
/** A delegated conversation of `agent` under `chain` (root first), its origin the root's, as tool-delegate's keys say. */
const delegated = (chain: string[], agent: string, origin: ConversationRef = root(chain[0] ?? "")): ConversationRef => ({
  key: `delegate:${chain.length}:${chain.join(".")}:t1`,
  agent,
  conversationId: `c-${chain.join(".")}-${agent}`,
  origin,
});

/** An App with tool-notify and the doubles; `stored` is what the queue holds, in order. */
async function start(options: { config?: NotifyConfig; agents?: string[] } = {}) {
  const clock = createManualClock();
  const stored: OutboundMessage[] = [];
  const queue = defineComponent({
    name: "queue-test",
    setup: (pikit) =>
      pikit.provide("outbound.queue", {
        async enqueue(message) {
          if (message.channel === "slack") throw new Error(`no transport is attached for the channel "${message.channel}"`);
          if (!stored.some((each) => each.idempotencyKey === message.idempotencyKey)) stored.push(message);
        },
      } as OutboundQueue),
  });
  const kv = createMemoryKeyValueStorage();
  const storage = defineComponent({ name: "kv-test", setup: (pikit) => pikit.provide("storage.kv", kv) });
  const agents = defineComponent({
    name: "agents-test",
    setup: (pikit) => (options.agents ?? ["assistant", "orchestrator", "developer", "support"]).forEach((name) => pikit.provideKeyed("agent.definition", name, { name, model: "x/y" })),
  });
  let tools: { get(name: string): ToolRegistration | undefined } | undefined;
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "probe",
    setup(pikit) {
      const handle = pikit.useKeyed("agent.tool");
      const actors = pikit.use("actor.mailbox");
      return {
        start() {
          tools = handle as never;
          mailbox = actors.get();
        },
      };
    },
  });
  const app = await defineApp({ components: [createMemoryMailbox(), storage, queue, agents, toolNotify, probe], config: { "tool-notify": options.config ?? config }, logger: silentLogger, clock }).create();
  await app.start();
  const tool = tools?.get(NOTIFY_TOOL) as ToolRegistration;
  /** Calls `notify` as the runtime does, in `conversation`'s run, as the call `callId`. */
  const notify = (args: Record<string, unknown>, conversation: ConversationRef = root("assistant"), callId = "call-1") =>
    tool.execute(args as never, { callId } as never, withContextValue(CONVERSATION, conversation, BACKGROUND_CONTEXT) as never);
  /** Calls the actor of `key` as the tool does. */
  const call = (key: string, type: string, message: JsonValue) => (mailbox as ActorMailbox).call(key, type, message, app.context());
  return { app, clock, stored, kv, tool, notify, call };
}

const textOf = (result: { output?: readonly { type: string; text?: string }[] }) => result.output?.map((part) => part.text ?? "").join("");

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const s = await start();
  expect(s.app.describe().components.find((component) => component.name === "tool-notify")).toMatchObject({
    provides: ["agent.tool"],
    requires: ["actor.mailbox", "actor.inbox", "outbound.queue", "storage.kv"],
    optional: ["agent.definition"],
  });
  expect(s.app.describe().capabilities["agent.tool"]?.keys).toEqual({ [NOTIFY_TOOL]: "tool-notify" });
  expect(s.tool.replay).toBe("safe");
  await s.app.stop();
});

test("it refuses to start when a from names an agent the App does not define, or no destination is named", async () => {
  const failure = (await start({ agents: ["assistant"] }).catch((error: unknown) => error)) as Error;
  expect(String(failure.cause)).toContain('"orchestrator" in the from of "ops"; "developer" in the from of "ops" is no agent.definition');
  const empty = (await start({ config: { destinations: {}, maxPerHour: 30 } }).catch((error: unknown) => error)) as Error;
  expect(String(empty.cause)).toContain("its config names no destination");
});

test("names only: the description and the schema list the configured names; an unknown one is refused and nothing is stored", async () => {
  const s = await start();
  expect(s.tool.description).toBe(notifyDescription(config));
  expect(s.tool.description).toContain("- ops: The operations group. (only from: orchestrator, developer)\n- team: The team's space.\n");
  const to = (s.tool.parameters as unknown as { properties: { to: { anyOf: { const: string }[] } } }).properties.to;
  expect(to.anyOf.map((each) => each.const)).toEqual(["ops", "team", "quiet", "offline"]);
  for (const to of ["nowhere", "constructor", "telegram:ops:-100123"]) await expect(s.notify({ to, text: "hi" })).rejects.toThrow(`there is no chat "${to}" to send to; the chats are: ops, team, quiet, offline`);
  expect(s.stored).toEqual([]);
  await s.app.stop();
});

test("a call stores the message in the destination's outbox, under the call's key, attributed; the result holds nothing of the destination's", async () => {
  const s = await start();
  expect(textOf(await s.notify({ to: "team", text: "Daily summary: **3** done." }))).toBe('Queued for "team".');
  expect(s.stored).toEqual([{ idempotencyKey: "c-assistant:tool-notify:call-1", channel: "googlechat", conversationKey: "googlechat:spaces/AAAA", text: "**assistant:**\nDaily summary: **3** done." }]);
  await s.app.stop();
});

test("attribution: false sends only what the model wrote", async () => {
  const s = await start();
  await s.notify({ to: "quiet", text: "Plain." });
  expect(s.stored.map((m) => m.text)).toEqual(["Plain."]);
  await s.app.stop();
});

test("a text longer than the limit is refused", async () => {
  const s = await start();
  await expect(s.notify({ to: "team", text: "x".repeat(TEXT_MAX + 1) })).rejects.toThrow(`the text is 1 to ${TEXT_MAX} characters`);
  expect(s.stored).toEqual([]);
  await s.app.stop();
});

test("from: an allowed agent sends; one it does not name is refused and nothing is stored", async () => {
  const s = await start();
  await s.notify({ to: "ops", text: "PR #12 is open." }, root("developer"));
  expect(s.stored.map((m) => [m.conversationKey, m.text])).toEqual([["telegram:ops:-100123", "**developer:**\nPR #12 is open."]]);
  await expect(s.notify({ to: "ops", text: "hi" }, root("support"), "call-2")).rejects.toThrow('"ops" takes messages only from orchestrator, developer; this conversation (support) may not send there');
  expect(s.stored).toHaveLength(1);
  await s.app.stop();
});

test("from: laundering through an allowed orchestrator is refused; a chain wholly in it is allowed", async () => {
  const s = await start();
  await expect(s.notify({ to: "ops", text: "hi" }, delegated(["support"], "orchestrator"))).rejects.toThrow("this conversation (orchestrator, delegated from support) may not send there");
  expect(s.stored).toEqual([]);
  await s.notify({ to: "ops", text: "hi" }, delegated(["orchestrator"], "developer"));
  expect(s.stored).toHaveLength(1);
  await s.app.stop();
});

test("from: a chain that cannot be trusted reaches no destination with from, and still one without", async () => {
  const s = await start();
  const untrusted: ConversationRef[] = [
    // The origin is not the chain's first agent; a delegate key without an origin; delegated under another key.
    delegated(["orchestrator"], "developer", root("support")),
    { key: "delegate:1:orchestrator:t1", agent: "developer", conversationId: "c" },
    { key: "telegram:9", agent: "developer", conversationId: "c", origin: root("developer") },
  ];
  for (const [i, conversation] of untrusted.entries()) {
    await expect(s.notify({ to: "ops", text: "hi" }, conversation, `ops-${i}`)).rejects.toThrow("this conversation's chain of delegations cannot be verified, so it may not send there");
    await s.notify({ to: "quiet", text: "hi" }, conversation, `quiet-${i}`);
  }
  expect(s.stored.map((m) => m.conversationKey)).toEqual(Array(3).fill("googlechat:spaces/BBBB"));
  await s.app.stop();
});

test("replay: the same call again stores one message and is counted once", async () => {
  const s = await start();
  for (let i = 0; i < 3; i++) await s.notify({ to: "team", text: "once" });
  expect(s.stored).toHaveLength(1);
  // team takes 2 an hour: the replays did not count, so a second call still fits.
  await s.notify({ to: "team", text: "twice" }, root("assistant"), "call-2");
  expect(s.stored).toHaveLength(2);
  await s.app.stop();
});

test("rate limit: over it the call is refused with when to try again; a replay of a counted call is not; another destination is unaffected", async () => {
  const s = await start();
  await s.notify({ to: "team", text: "1" }, root("assistant"), "a");
  await s.clock.advance(10 * 60_000);
  await s.notify({ to: "team", text: "2" }, root("assistant"), "b");
  await expect(s.notify({ to: "team", text: "3" }, root("assistant"), "c")).rejects.toThrow('"team" takes at most 2 messages an hour; the next one fits in 50 minutes');
  // A replay of a counted call goes through (and stores nothing new); another destination takes messages.
  await s.notify({ to: "team", text: "1" }, root("assistant"), "a");
  await s.notify({ to: "quiet", text: "other" }, root("assistant"), "d");
  expect(s.stored.map((m) => m.text)).toEqual(["**assistant:**\n1", "**assistant:**\n2", "other"]);
  // An hour after the first, one fits again.
  await s.clock.advance(50 * 60_000);
  await s.notify({ to: "team", text: "3" }, root("assistant"), "c");
  expect(s.stored).toHaveLength(4);
  await s.app.stop();
});

test("no transport attached for the channel: the call fails saying why, nothing is stored, and nothing is counted", async () => {
  const s = await start({ config: { ...config, destinations: { ...config.destinations, offline: { ...config.destinations.offline!, maxPerHour: 1 } } } });
  for (const id of ["x", "y"]) await expect(s.notify({ to: "offline", text: "hi" }, root("assistant"), id)).rejects.toThrow('nothing was sent to "offline": no transport is attached for the channel "slack"');
  expect(s.stored).toEqual([]);
  expect(await s.kv.namespace("tool-notify").get("hour:offline")).toBeUndefined();
  await s.app.stop();
});

test("the destination's actor refuses a call that is not for its key, or malformed", async () => {
  const s = await start();
  const message = { to: "team", idempotencyKey: "k", text: "hi" };
  for (const [key, body] of [
    ["googlechat:spaces/BBBB", message],
    ["googlechat:spaces/AAAA", { ...message, to: "nowhere" }],
    ["googlechat:spaces/AAAA", { ...message, text: "" }],
    ["googlechat:spaces/AAAA", "hi"],
  ] as const) {
    const refused = await s.call(key, ENQUEUE, body).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid");
  }
  expect(s.stored).toEqual([]);
  await s.app.stop();
});
