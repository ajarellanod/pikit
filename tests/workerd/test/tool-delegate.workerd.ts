/**
 * tool-delegate on Cloudflare: a conversation object's App with storage-do, actors-do (its
 * `actor.inbox` and `wakeups`), runtime-pi driving its runs in wakeups, and the scripted model. The
 * assistant delegates to the helper: the task is a child conversation in the same object's storage
 * (pi-durable's subagents), driven by the same alarm. Waited for, its answer is the call's; not waited
 * for, a background task reports it to the assistant, whose answer is announced like any other.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type ConversationRef, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it } from "vitest";
import { vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import toolDelegate from "../../../registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  await resetObjects();
});

/** The assistant (it delegates) and the helper (`hold` returns once released), on the scripted model. */
function agents(held: { released: Promise<void> }) {
  const assistant = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate"] });
  const helper = defineAgent({ name: "helper", model: "faux/scripted", tools: [holdTool(() => held.released.then(() => "released"))] });
  const provider = scriptedProvider();
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => [assistant, helper].forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/** A channel's object half: admits each message to the assistant, and records every announced result. */
function channelActor(results: { requestId: string; text: string | undefined }[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void results.push({ requestId: result.requestId, text: result.text }));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversation: ConversationRef = { key, agent: "assistant", conversationId: await conversations.get().create(ctx) };
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text, sender: { channel: "test", id: "alice" } }, ctx);
          });
        },
      };
    },
  });
}

async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [actorsDo, channel], config: { "actors-do": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    send: (key: string, message: { id: string; text: string }) => mailbox?.send(key, "test.message", message, worker.context()),
    stop: () => worker.stop(),
  };
}

function compose(results: { requestId: string; text: string | undefined }[], held: { released: Promise<void> }) {
  composeObjects([storageDo, actorsDo, ...agents(held), toolDelegate, runtimePi, channelActor(results)], {
    "tool-delegate": { agents: [{ name: "helper", description: "Helps." }] },
  });
}

it("delegate waits for the helper, a child conversation in the same object, driven by its alarm", async () => {
  const results: { requestId: string; text: string | undefined }[] = [];
  compose(results, { released: Promise.resolve() });
  const worker = await workerApp();
  try {
    await worker.send(`test:${crypto.randomUUID()}`, { id: "m1", text: 'call: delegate {"agent":"helper","task":"hold"}' });
    // The assistant's run ends once its tool has the helper's answer; the helper's run is not announced.
    await vi.waitFor(() => expect(results.map((each) => each.requestId)).toEqual(["m1"]), { timeout: 10_000 });
  } finally {
    await worker.stop();
  }
});

it("delegate with wait: false: the assistant answers at once, and the helper's answer comes back as a message of its own", async () => {
  const results: { requestId: string; text: string | undefined }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  compose(results, { released });
  const worker = await workerApp();
  try {
    await worker.send(`test:${crypto.randomUUID()}`, { id: "m1", text: 'call: delegate {"agent":"helper","task":"hold","wait":false}' });
    await vi.waitFor(() => expect(results.map((each) => each.requestId)).toEqual(["m1"]), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect(results.map((each) => each.requestId.split(":")[0])).toEqual(["m1", "delegate-result"]), { timeout: 10_000 });
    expect(results[1]?.text).toContain('[The agent "helper" finished the task you delegated to it.');
  } finally {
    await worker.stop();
  }
});
