/**
 * mailbox-local's tests. They are copied with the component and keep running in your project: the
 * `actor.mailbox` and `actor.inbox` conformance suite (also with `wakeups` in the app: an actor that
 * handles, sends and wakes itself composes), the lifecycle suite, and what it does when the app stops.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorInboxHandler, type ActorMailbox, type ActorStreamHandler } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createMailboxConformance, createMemoryWakeups } from "@pikit/contracts/testing";
import mailboxLocal from "./index.ts";

// The actor.mailbox contract: the suite's inbox is installed in the same App, as on a server.
for (const c of createMailboxConformance((inbox) => ({ components: [inbox, mailboxLocal] }))) {
  test(`mailbox-local ${c.group}: ${c.name}`, () => c.run());
}

// The same with wakeups in the app: the suite's actor also registers a wakeup handler and asks for it.
for (const c of createMailboxConformance((inbox) => ({ components: [inbox, mailboxLocal, createMemoryWakeups()] }), { wakeups: true })) {
  test(`mailbox-local with wakeups ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline, and a fresh app starts again.
for (const c of createLifecycleConformance(() => ({ component: mailboxLocal }))) {
  test(`mailbox-local ${c.group}: ${c.name}`, () => c.run());
}

/** An actor that registers `handler` for the type "test.message" in its start. */
const actorOf = (handler: ActorInboxHandler) =>
  defineComponent({
    name: "test-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      return { start: () => inbox.get().handle("test.message", handler) };
    },
  });

/** An app of mailbox-local and `handler` under the type "test.message" (and `stream` under "test.stream"); its mailbox and app. */
async function open(handler: ActorInboxHandler, stream?: ActorStreamHandler) {
  let mailbox: ActorMailbox | undefined;
  const actor = stream === undefined ? actorOf(handler) : defineComponent({
    name: "test-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      return { start: () => (inbox.get().handle("test.message", handler), inbox.get().answerStream("test.stream", stream)) };
    },
  });
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actor, mailboxLocal, channel], logger: silentLogger }).create();
  await app.start();
  if (mailbox === undefined) throw new Error("actor.mailbox was not resolved");
  return { mailbox, app };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [mailboxLocal], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "mailbox-local")).toMatchObject({
    provides: ["actor.inbox", "actor.mailbox"],
    requires: [],
    optional: [],
  });
});

test("stop cancels a running handler's context and waits for it; a send after stop is refused, saying why", async () => {
  let finished = false;
  const { mailbox, app } = await open(
    (_key, _message, ctx) =>
      new Promise<void>((resolve) =>
        ctx.abortSignal?.addEventListener("abort", () => {
          finished = true;
          resolve();
        }),
      ),
  );
  const sent = mailbox.send("telegram:1", "test.message", { id: 1 }, app.context());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await app.stop();
  expect(finished).toBe(true);
  await sent;
  await expect(mailbox.send("telegram:1", "test.message", { id: 2 }, app.context())).rejects.toThrow("while the app is not running");
});

test("stop ends an open stream as unreachable and closes its handler's, even one that heeds nothing", async () => {
  let closed = false;
  const { mailbox, app } = await open(async () => {}, async () =>
    (async function* () {
      try {
        yield "first";
        yield "second";
      } finally {
        closed = true;
      }
    })(),
  );
  const iterator = (await mailbox.stream("telegram:1", "test.stream", null, app.context()))[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe("first");
  await app.stop();
  const error = await iterator.next().then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ActorCallError);
  expect((error as ActorCallError).code).toBe("unreachable");
  for (let i = 0; i < 50 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(closed).toBe(true);
  await expect(mailbox.stream("telegram:1", "test.stream", null, app.context())).rejects.toMatchObject({ code: "unreachable" });
});

test("a type nobody handles is refused with the types that are handled", async () => {
  const { mailbox, app } = await open(async () => {});
  try {
    await expect(mailbox.send("telegram:1", "test.mesage", {}, app.context())).rejects.toThrow('no actor.inbox handler for the type "test.mesage" (handled: test.message)');
  } finally {
    await app.stop();
  }
});

test("handlers are dropped at stop: a new app's actor registers the same type again", async () => {
  const received: unknown[] = [];
  const first = await open(async () => {});
  await first.app.stop();
  const { mailbox, app } = await open(async (_key, message) => void received.push(message));
  try {
    await mailbox.send("telegram:1", "test.message", "again", app.context());
    expect(received).toEqual(["again"]);
  } finally {
    await app.stop();
  }
});
