/**
 * runtime-pi on Cloudflare: a conversation object's App as a Cloudflare project composes it, in a real
 * SQLite-backed Durable Object of deployment-cloudflare's `Conversation` class (`PlatformConversation`,
 * `src/platform.ts`): sessions on `sessions-sql` over `storage-do`,
 * `platform-cloudflare` for `actor.inbox` and `wakeups`, `runtime-pi` driving its runs in wakeups, the
 * scripted model, and a channel's object half that handles its messages and uses `wakeups` itself.
 * The Worker's App sends a message by RPC; the run is driven in the object's real alarm, and answers.
 *
 * The scripted model and agent come from `@pikit/pi-adapter`'s test support, file by file: its index
 * also exports server-only fixtures (processes, files).
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type ConversationRef, WORKERS_HOST } from "@pikit/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { holdTool, scriptedAgent, scriptedProvider } from "../../../packages/pi-adapter/src/testing/script.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import runtimePi, { DRIVE } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import sessionsSql from "../../../registry/components/sessions-sql/files/src/pikit/sessions-sql/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(() => resetObjects());

/** The scripted agent and model: each run answers `answer: <message>`. */
function model() {
  const agent = scriptedAgent(holdTool(async () => "released"));
  const provider = scriptedProvider();
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/** A channel's object half: admits its messages to the runtime, and uses `wakeups` itself. */
function channelActor(answers: (string | undefined)[], drives: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const wakeups = pikit.use("wakeups");
      const runtime = pikit.use("agent.runtime");
      const sessions = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const session = await sessions.get().create({ cwd: "/" }, ctx);
            await session.close(ctx);
            const conversation: ConversationRef = { key, agent: "scripted", sessionId: session.metadata.id };
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
            // What runtime-pi asked for, read back from platform-cloudflare's table in the object.
            const storage = ctx.value(WORKERS_HOST)?.object?.storage as DurableObjectStorage;
            for (const row of storage.sql.exec("SELECT name FROM platform_cloudflare_wakeups").toArray()) drives.push(String(row.name));
          });
          wakeups.get().handle("test-channel-actor.tidy", async () => {});
        },
      };
    },
  });
}

it("runtime-pi runs on platform-cloudflare's wakeups in a real object: a message sent from the Worker is answered in the object's alarm", async () => {
  const answers: (string | undefined)[] = [];
  const drives: string[] = [];
  composeObjects([storageDo, sessionsSql, platformCloudflare, ...model(), runtimePi, channelActor(answers, drives)]);

  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [platformCloudflare, channel], config: { "platform-cloudflare": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  try {
    const key = `test:${crypto.randomUUID()}`;
    await mailbox?.send(key, "test.message", { id: "m1", text: "hello" }, worker.context());
    // Once the message was admitted, the run was left to the wakeup that drives it.
    expect(drives).toContain(DRIVE);
    await vi.waitFor(() => expect(answers).toEqual(["answer: hello"]), { timeout: 10_000 });
    // The object's alarm ran the drive handler, which resolved: its request is done.
    const object = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
    await vi.waitFor(
      () =>
        runInDurableObject(object, async (_instance, state) => {
          expect(state.storage.sql.exec("SELECT name FROM platform_cloudflare_wakeups WHERE name = ?", DRIVE).toArray()).toEqual([]);
          expect(await state.storage.getAlarm()).toBeNull();
        }),
      { timeout: 10_000 },
    );
  } finally {
    await worker.stop();
  }
});
