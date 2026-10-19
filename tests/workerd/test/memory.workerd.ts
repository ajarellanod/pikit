/**
 * memory-sql and memory-recall on Cloudflare: each person's memory in the Durable Object
 * `memory:<person>` (deployment-cloudflare's `Conversation` class, as `PlatformConversation`,
 * `src/platform.ts`), reached through actors-do's `actor.mailbox` by RPC.
 *
 * - The `memory` suite from an App in an object of its own (storage-do, actors-do, memory-sql): every
 *   call crosses to the person's object, which keeps the rows in its own SQLite; a restart is a second
 *   App. A call for another person reaches that person's object and is refused there (`invalid`).
 * - A conversation's object (runtime-pi on provider-faux's `faux/scripted`, memory-recall): the model
 *   calls `remember`, the fact lands in the person's object, not the conversation's, and the
 *   conversation's next request carries it in its `memory` section; another chat has none.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { ActorCallError, type ActorMailbox } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { defineAgent } from "@pikit/contracts";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import memoryRecall from "../../../registry/components/memory-recall/files/src/pikit/memory-recall/index.ts";
import { createMemoryConformance } from "../../../registry/components/memory-sql/files/src/pikit/memory-sql/conformance.ts";
import memorySql, { actorKey, CALL } from "../../../registry/components/memory-sql/files/src/pikit/memory-sql/index.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };

afterEach(() => resetObjects());

for (const c of createMemoryConformance(() => {
  composeObjects([storageDo, actorsDo, memorySql]);
  return { components: () => withWorkersHost(objectHost(), [storageDo, actorsDo, memorySql]), config: ACTORS, target: "durable" };
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
  return { app, call: (key: string, type: string, message: Parameters<ActorMailbox["call"]>[2]) => (mailbox as ActorMailbox).call(key, type, message, app.context()) };
}

it("a person's object refuses a call for another person", async () => {
  composeObjects([storageDo, actorsDo, memorySql]);
  const worker = await workerApp();
  try {
    const ana = { agent: "assistant", person: `test:ana-${crypto.randomUUID()}` };
    const refused = await worker.call(actorKey(`test:bob-${crypto.randomUUID()}`), CALL.list, { ...ana, kind: "fact", limit: 10 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid");
    expect(await worker.call(actorKey(ana.person), CALL.list, { ...ana, kind: "fact", limit: 10 })).toEqual([]);
  } finally {
    await worker.app.stop();
  }
});

/** A channel's object half: each message to its key's conversation of `assistant`; answers pushed to `answers`. */
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
            const { id, text } = message as { id: string; text: string };
            const conversation = await registry.get().resolve(key, "assistant", "test", ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
        },
      };
    },
  });
}

it("in a conversation's object the model remembers a fact in the person's object, and the next request shows it", async () => {
  const answers: string[] = [];
  const agent = defineAgent({ name: "assistant", model: "faux/scripted", extensions: ["memory"] });
  const agents = defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
  composeObjects([storageDo, storageKvSql, actorsDo, agents, providerFaux, runtimePi, conversationsKv, memorySql, memoryRecall, channelActor(answers)]);
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
  const send = (key: string, id: string, text: string) => (mailbox as ActorMailbox).send(key, "test.message", { id, text }, app.context());
  const chat = `test:${crypto.randomUUID()}`;
  const other = `test:${crypto.randomUUID()}`;
  try {
    await send(chat, "m1", 'call: remember {"fact":"Ana prefers tea"}');
    await vi.waitFor(() => expect(answers.some((a) => a.startsWith(`${chat}: remember: Remembered (id `))).toBe(true), { timeout: 10_000 });

    // The fact is in the person's object.
    const kept = (await (mailbox as ActorMailbox).call(actorKey(chat), CALL.list, { agent: "assistant", person: chat, kind: "fact", limit: 10 }, app.context())) as { text: string }[];
    expect(kept.map((m) => m.text)).toEqual(["Ana prefers tea"]);

    await send(chat, "m2", "echo-system memory");
    await vi.waitFor(() => expect(answers.find((a) => a.startsWith(`${chat}: <memory>`))).toContain("- Ana prefers tea (id "), { timeout: 10_000 });
    await send(other, "m1", "echo-system memory");
    await vi.waitFor(() => expect(answers).toContain(`${other}: (no section memory)`), { timeout: 10_000 });
  } finally {
    await app.stop();
  }
});
