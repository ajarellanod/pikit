/**
 * memory-sql, memory-recall and memory-summaries on Cloudflare: each owner's memory (a space's, an
 * agent's kept apart, a person's) in the Durable Object of its key (`memory:space:<space>`...,
 * deployment-cloudflare's `Conversation` class, as `PlatformConversation`, `src/platform.ts`), reached
 * through actors-do's `actor.mailbox` by RPC.
 *
 * - The `memory` suite from an App in an object of its own (storage-do, actors-do, memory-sql, with
 *   `trader` kept apart): every call crosses to the owner's object, which keeps the rows, and the FTS5
 *   index, in its own SQLite; a restart is a second App. A call for another owner reaches that owner's
 *   object and is refused there (`invalid`).
 * - Threads of a space, each a conversation's object (runtime-pi on provider-faux's `faux/scripted`,
 *   conversations-kv recording the space, memory-recall): the model calls `remember`, the fact lands in
 *   the space's object, not the conversation's, and another thread's next request carries it in its
 *   `memory` section; a thread of another space has none.
 * - memory-summaries in a conversation's object: a run settles, `Date` is moved past `idleMinutes`, and
 *   the object's alarm (actors-do's `wakeups`) summarizes the thread with `faux/echo` into the space's
 *   object.
 */

import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { ActorCallError, type ActorMailbox, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import memoryRecall from "../../../registry/components/memory-recall/files/src/pikit/memory-recall/index.ts";
import { createMemoryConformance } from "../../../registry/components/memory-sql/files/src/pikit/memory-sql/conformance.ts";
import memorySql, { actorKey, CALL } from "../../../registry/components/memory-sql/files/src/pikit/memory-sql/index.ts";
import memorySummaries from "../../../registry/components/memory-summaries/files/src/pikit/memory-summaries/index.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };
const CONFIG = { ...ACTORS, "memory-sql": { agentScope: ["trader"] } };

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

for (const c of createMemoryConformance(() => {
  composeObjects([storageDo, actorsDo, memorySql], CONFIG);
  return { components: () => withWorkersHost(objectHost(), [storageDo, actorsDo, memorySql]), config: CONFIG, target: "durable", agentScope: ["trader"] };
})) {
  it(`memory-sql over storage-do and actors-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** The Worker's App: a mailbox to the objects. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "test-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, probe], config: ACTORS, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    call: (key: string, type: string, message: Parameters<ActorMailbox["call"]>[2]) => (mailbox as ActorMailbox).call(key, type, message, app.context()),
    send: (key: string, type: string, message: Parameters<ActorMailbox["send"]>[2]) => (mailbox as ActorMailbox).send(key, type, message, app.context()),
  };
}

it("an owner's object refuses a call for another owner", async () => {
  composeObjects([storageDo, actorsDo, memorySql], CONFIG);
  const worker = await workerApp();
  try {
    const team = { type: "space", space: `test:spaces/${crypto.randomUUID()}` } as const;
    const other = { type: "space", space: `test:spaces/${crypto.randomUUID()}` } as const;
    const refused = await worker.call(actorKey(other), CALL.list, { owner: team, kinds: ["fact"], limit: 10 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid");
    expect(await worker.call(actorKey(team), CALL.list, { owner: team, kinds: ["fact"], limit: 10 })).toEqual([]);
  } finally {
    await worker.app.stop();
  }
});

/**
 * A channel's object half: each message to its key's conversation of `agent`, the key a thread of
 * `space` (resolved with it, as a channel admits it), from Ana; answers pushed to `answers`.
 */
function channelActor(answers: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result) => void answers.push(`${result.conversation.key}: ${result.text}`));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text, space } = message as { id: string; text: string; space: string };
            const conversation = await registry.get().resolve(key, "assistant", { channel: "test", space }, ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text, sender: { channel: "test", id: "ana" } }, ctx);
          });
        },
      };
    },
  });
}

const agent = defineAgent({ name: "assistant", model: "faux/scripted", extensions: ["memory"] });
const agents = defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
const SUMMARIES = { "memory-summaries": { model: "faux/echo", agents: ["assistant"], idleMinutes: 1 } };

it("in a thread's object the model remembers a fact in the space's object, and another thread of the space shows it; another space's does not", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, agents, providerFaux, runtimePi, conversationsKv, memorySql, memoryRecall, channelActor(answers)], CONFIG);
  const worker = await workerApp();
  const space = `test:spaces/${crypto.randomUUID()}`;
  const other = `test:spaces/${crypto.randomUUID()}`;
  const say = (thread: string, id: string, text: string, where = space) => worker.send(`${where}:threads/${thread}`, "test.message", { id, text, space: where });
  try {
    await say("1", "m1", 'call: remember {"fact":"Acme budget is 10k"}');
    await vi.waitFor(() => expect(answers.some((a) => a.startsWith(`${space}:threads/1: remember: Remembered (id `))).toBe(true), { timeout: 10_000 });

    // The fact is in the space's object.
    const owner = { type: "space", space } as const;
    const kept = (await worker.call(actorKey(owner), CALL.list, { owner, kinds: ["fact"], limit: 10 })) as { text: string }[];
    expect(kept.map((m) => m.text)).toEqual(["Acme budget is 10k"]);
    expect(await worker.call(actorKey(owner), CALL.search, { owner, query: "ACME budget", limit: 10 })).toMatchObject([{ snippet: "[Acme] [budget] is 10k" }]);

    await say("2", "m2", "echo-system memory");
    await vi.waitFor(() => expect(answers.find((a) => a.startsWith(`${space}:threads/2: <memory>`))).toContain("- Acme budget is 10k (id "), { timeout: 10_000 });
    await say("1", "m3", "echo-system memory", other);
    await vi.waitFor(() => expect(answers).toContain(`${other}:threads/1: (no section memory)`), { timeout: 10_000 });
  } finally {
    await worker.app.stop();
  }
});

it("memory-summaries in a thread's object: once quiet, its alarm summarizes the thread into the space's object", async () => {
  const answers: string[] = [];
  composeObjects(
    [storageDo, storageKvSql, actorsDo, agents, providerFaux, runtimePi, conversationsKv, memorySql, memoryRecall, memorySummaries, channelActor(answers)],
    { ...CONFIG, ...SUMMARIES },
  );
  const worker = await workerApp();
  const space = `test:spaces/${crypto.randomUUID()}`;
  const key = `${space}:threads/1`;
  const owner = { type: "space", space } as const;
  const summaries = async () => (await worker.call(actorKey(owner), CALL.list, { owner, kinds: ["summary"], limit: 10 })) as { id: string; text: string }[];
  try {
    await worker.send(key, "test.message", { id: "m1", text: "I like green tea", space });
    await vi.waitFor(() => expect(answers).toContain(`${key}: faux: I like green tea`), { timeout: 10_000 });
    expect(await summaries()).toEqual([]);

    // Quiet for longer than idleMinutes: the thread's alarm (actors-do's wakeups) summarizes it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000, shouldAdvanceTime: true });
    const thread = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(thread);
        expect(await summaries()).toHaveLength(1);
      },
      { timeout: 10_000, interval: 100 },
    );
    const [summary] = await summaries();
    expect(summary?.id).toMatch(/^summary:.+:.+$/);
    expect(summary?.text).toContain("Person: I like green tea");
  } finally {
    await worker.app.stop();
  }
});
