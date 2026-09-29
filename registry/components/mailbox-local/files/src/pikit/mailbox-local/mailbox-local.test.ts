/**
 * mailbox-local's tests. They are copied with the component and keep running in your project: the
 * `actor.mailbox` conformance suite, the lifecycle suite, and what it does when the app stops.
 */

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createMailboxConformance } from "@pikit/contracts/testing";
import mailboxLocal from "./index.ts";

// The actor.mailbox contract: the suite's inbox is installed in the same App, as on a server.
for (const c of createMailboxConformance((inbox) => ({ components: [inbox, mailboxLocal] }))) {
  test(`mailbox-local ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline, and a fresh app starts again.
for (const c of createLifecycleConformance(() => ({ component: mailboxLocal }))) {
  test(`mailbox-local ${c.group}: ${c.name}`, () => c.run());
}

/** An app of mailbox-local and `handler` under the type "test.message"; its mailbox and app. */
async function open(handler: (key: string, message: JsonValue, ctx: AppContext) => Promise<void>) {
  let mailbox: ActorMailbox | undefined;
  const actor = defineComponent({ name: "test-actor", setup: (pikit) => pikit.provideKeyed("actor.inbox", "test.message", handler) });
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
    provides: ["actor.mailbox"],
    requires: [],
    optional: ["actor.inbox"],
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

test("a type nobody handles is refused with the types that are handled", async () => {
  const { mailbox, app } = await open(async () => {});
  try {
    await expect(mailbox.send("telegram:1", "test.mesage", {}, app.context())).rejects.toThrow('no actor.inbox handler for the type "test.mesage" (handled: test.message)');
  } finally {
    await app.stop();
  }
});
