/**
 * tool-notify in a real App, as a server composes it: runtime-pi runs the agents on a SQLite file with
 * the scripted faux model (`call: notify <json>` calls the tool), mailbox-local is every key's actor,
 * outbound-durable keeps the outbox and storage-kv-sql the rate limit's count, and a test channel
 * attaches the transport of `telegram` (it records what it sends).
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppEvents, defineApp, defineComponent, silentLogger, withContextValue, BACKGROUND_CONTEXT } from "@pikit/core";
import { type AgentRuntime, type AgentSubmissions, CONVERSATION, type ConversationRegistry, type ConversationRef, defineAgent, type OutboundPiece, type OutboundQueue } from "@pikit/contracts";
import { scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import type { ToolRegistration } from "@pikit/pi-adapter/tools";
import conversationsKv from "../conversations-kv/files/src/pikit/conversations-kv/index.ts";
import mailboxLocal from "../mailbox-local/files/src/pikit/mailbox-local/index.ts";
import outboundDurable from "../outbound-durable/files/src/pikit/outbound-durable/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import wakeupsTimers from "../wakeups-timers/files/src/pikit/wakeups-timers/index.ts";
import toolNotify, { NOTIFY_TOOL } from "./files/src/pikit/tool-notify/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
const OPS = "telegram:-100123";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-notify-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const results: Result[] = [];
  const sends: OutboundPiece[] = [];
  let reached:
    | { runtime: AgentRuntime; create: () => Promise<string>; queue: OutboundQueue; tool: ToolRegistration; registry: ConversationRegistry; submissions: AgentSubmissions }
    | undefined;
  const provider = scriptedProvider();
  const agent = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["notify"] });
  const components = [
    sqliteStorage(join(dir, "pikit.db")),
    storageKvSql,
    mailboxLocal,
    wakeupsTimers,
    outboundDurable,
    defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
    runtimePi,
    conversationsKv,
    toolNotify,
    defineComponent({
      name: "observer",
      setup(pikit) {
        const runtime = pikit.use("agent.runtime");
        const conversations = pikit.use("agent.conversations");
        const queue = pikit.use("outbound.queue");
        const tools = pikit.useKeyed("agent.tool");
        const registry = pikit.use("conversations.registry");
        const submissions = pikit.use("agent.submissions");
        pikit.on("agent.settled", (result) => void results.push(result));
        pikit.on("agent.failed", (result) => void results.push(result));
        return {
          start(ctx) {
            // The channel's transport: one piece per message, each send recorded.
            queue.get().attach("telegram", { idempotent: false, split: (text) => [text], send: async (piece) => (sends.push(piece), { platformMessageId: `p${sends.length}` }) });
            reached = {
              runtime: runtime.get(),
              create: () => conversations.get().create(ctx),
              queue: queue.get(),
              tool: tools.get(NOTIFY_TOOL) as ToolRegistration,
              registry: registry.get(),
              submissions: submissions.get(),
            };
          },
        };
      },
    }),
  ];
  const config = { "tool-notify": { destinations: { ops: { channel: "telegram", conversation: OPS, description: "The operations group.", maxPerHour: 2 }, offline: { channel: "slack", conversation: "slack:C1", description: "No transport." } } } };
  const app: App = await defineApp({ components, config, logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();
  const until = async <T>(found: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = found();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  };
  return {
    app,
    sends,
    results,
    live,
    until,
    async ask(key: string, prompt: string): Promise<ConversationRef> {
      const conversation = { key, agent: "assistant", conversationId: await live().create() };
      await live().runtime.dispatch({ requestId: `${key}:1`, conversation, prompt, sender: { channel: "test", id: "alice" } }, app.context());
      return conversation;
    },
    result: (requestId: string) => until(() => results.find((r) => r.requestId === requestId), `the result of ${requestId}`),
  };
}

/** The text of the tool results a run added. */
const toolResults = (result: Result): string[] =>
  (result.messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

/** Calls `notify` directly, as the runtime does in `conversation`'s run, as the call `callId`. */
const tool =
  (notify: ToolRegistration, conversation: ConversationRef) =>
  (callId: string, to = "ops") =>
    notify.execute({ to, text: "once" } as never, { callId } as never, withContextValue(CONVERSATION, conversation, BACKGROUND_CONTEXT) as never);

test("send-only: the message reaches the destination's chat; its key gets no conversation, no submission and no run", async () => {
  const s = await start();
  await s.ask("test:1", 'call: notify {"to":"ops","text":"Deployed v2."}');
  const result = await s.result("test:1:1");
  expect(toolResults(result)).toEqual(['Queued for "ops".']);
  await s.until(() => (s.sends.length > 0 ? true : undefined), "the send");
  expect(s.sends.map((p) => [p.conversationKey, p.text])).toEqual([[OPS, "**assistant:**\nDeployed v2."]]);
  expect(s.sends[0]?.key).toMatch(/^.+:tool-notify:.+#0$/);

  const ctx = s.app.context();
  expect(await s.live().registry.get(OPS, ctx)).toBeUndefined();
  expect(await s.live().submissions.pending(ctx)).toEqual([]);
  expect((await s.live().submissions.answers.read(undefined, 100)).items.map((each) => each.fact.conversation.key)).toEqual(["test:1"]);
  expect(s.results.map((r) => r.conversation.key)).toEqual(["test:1"]);
});

test("replay: the same call run twice stores one message in outbound-durable and counts once", async () => {
  const s = await start();
  const call = tool(s.live().tool, { key: "test:9", agent: "assistant", conversationId: "c9" });
  await call("k1");
  await call("k1");
  await s.until(() => (s.sends.length > 0 ? true : undefined), "the send");
  // ops takes 2 an hour: the replay did not count, so one more fits, and the next does not.
  await call("k2");
  await expect(call("k3")).rejects.toThrow('"ops" takes at most 2 messages an hour');
  await s.until(() => (s.sends.length === 2 ? true : undefined), "two sends");
  const receipts = await s.live().queue.receipts.read(undefined, 100);
  expect(receipts.items.map((each) => each.fact.idempotencyKey)).toEqual(["c9:tool-notify:k1", "c9:tool-notify:k2"]);
  expect(s.sends.map((p) => p.key)).toEqual(["c9:tool-notify:k1#0", "c9:tool-notify:k2#0"]);
});

test("no transport attached for the destination's channel: the call fails saying why, and outbound-durable stores nothing", async () => {
  const s = await start();
  const conversation: ConversationRef = { key: "test:9", agent: "assistant", conversationId: "c9" };
  const call = tool(s.live().tool, conversation);
  await expect(call("k1", "offline")).rejects.toThrow('nothing was sent to "offline": ');
  expect((await s.live().queue.pending({ limit: 10 })).items).toEqual([]);
});

test("one outbox per chat: two conversations notifying one destination fill one lane, in the order stored", async () => {
  const s = await start();
  await s.ask("test:a", 'call: notify {"to":"ops","text":"from a"}');
  await s.result("test:a:1");
  await s.ask("test:b", 'call: notify {"to":"ops","text":"from b"}');
  await s.result("test:b:1");
  await s.until(() => (s.sends.length === 2 ? true : undefined), "two sends");
  expect(s.sends.map((p) => [p.conversationKey, p.text])).toEqual([
    [OPS, "**assistant:**\nfrom a"],
    [OPS, "**assistant:**\nfrom b"],
  ]);
});
