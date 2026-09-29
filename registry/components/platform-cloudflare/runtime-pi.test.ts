/**
 * platform-cloudflare with runtime-pi, in a conversation object's App: the graph a keyed
 * `actor.inbox` made a dependency cycle (the mailbox's provider depended on every handler's component,
 * which used the runtime, which used the same provider's `wakeups`). With handlers registered by
 * method, it composes, and a message delivered to the object is answered by a run its wakeups drive.
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (S4), so this one lives beside `files/`. The object is the component's double (its alarm
 * on the app's clock, its SQL in `node:sqlite`); `tests/workerd` runs the same App on a real object.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ConversationRef, type JsonValue, WORKERS_HOST } from "@pikit/contracts";
import type {} from "@pikit/pi-adapter";
import { testComponents } from "@pikit/pi-adapter/testing";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import platformCloudflare from "./files/src/pikit/platform-cloudflare/index.ts";
import { simulatedObject } from "./files/src/pikit/platform-cloudflare/object.test-support.ts";
import { fakeSql } from "./files/src/pikit/platform-cloudflare/sql.test-support.ts";

/**
 * A channel's object half, as real ones will be: it handles its messages through `actor.inbox`, admits
 * them to the runtime, and uses `wakeups` itself. Each answer is recorded in `answers`.
 */
function channelActor() {
  const answers: (string | undefined)[] = [];
  const component = defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const wakeups = pikit.use("wakeups");
      const runtime = pikit.use("agent.runtime");
      const sessions = pikit.use("sessions.store");
      const conversations = new Map<string, ConversationRef>();
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            let conversation = conversations.get(key);
            if (conversation === undefined) {
              const session = await sessions.get().create({ cwd: "/" }, ctx);
              await session.close(ctx);
              conversation = { key, agent: "scripted", sessionId: session.metadata.id };
              conversations.set(key, conversation);
            }
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
          wakeups.get().handle("test-channel-actor.tidy", async () => {});
        },
      };
    },
  });
  return { component, answers };
}

test("an object's App composes platform-cloudflare, runtime-pi on its wakeups, and an actor that handles messages and wakes; a delivered message is answered in an alarm", async () => {
  const object = simulatedObject(fakeSql());
  const { sessions, agents, provider } = testComponents();
  const actor = channelActor();
  const app = await defineApp({
    components: [actor.component, runtimePi, sessions, agents, provider, platformCloudflare, object.component],
    logger: silentLogger,
  }).create();
  const order = app.describe().components.map((component) => component.name);
  expect(order.indexOf("platform-cloudflare")).toBeLessThan(order.indexOf("runtime-pi"));
  expect(order.indexOf("runtime-pi")).toBeLessThan(order.indexOf("test-channel-actor"));

  await app.start(withContextValue(WORKERS_HOST, object.host, BACKGROUND_CONTEXT));
  try {
    await object.deliver("test.message", "test:conversation-1", { id: "m1", text: "hello" } satisfies JsonValue);
    for (let waited = 0; actor.answers.length === 0 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(actor.answers).toEqual(["answer: hello"]);
    // The run was driven inside the object's alarm (runtime-pi.drive), not by a promise left running.
    expect(object.fired()).toBeGreaterThan(0);
  } finally {
    await app.stop();
  }
});
