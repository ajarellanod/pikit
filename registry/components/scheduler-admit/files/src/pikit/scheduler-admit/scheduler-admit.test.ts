/**
 * scheduler-admit's tests, copied with it: what setup declares, the message a tick becomes, and the
 * ticks its key's actor refuses. Ticks admitted through runtime-pi, answered and deduplicated, are
 * `app.test.ts` beside `files/` in the registry.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ActorMailbox, AgentRuntime, ConversationRegistry, JsonValue } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import schedulerAdmit, { TICK, tickMessage } from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const fakes = defineComponent({
    name: "fakes-test",
    setup(pikit) {
      pikit.provide("scheduler", {} as never);
      pikit.provide("agent.runtime", {} as never);
      pikit.provide("conversations.registry", {} as never);
    },
  });
  const app = await defineApp({ components: [fakes, createMemoryMailbox(), schedulerAdmit], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-admit")).toMatchObject({
    provides: [],
    requires: ["scheduler", "agent.runtime", "conversations.registry", "actor.mailbox", "actor.inbox"],
    optional: [],
  });
});

test("a tick's message: its id is the job's and the tick's, its sender the job, from the scheduler's channel", () => {
  const job = { id: "tool-schedule:c1:call-1", key: "telegram:12345", prompt: "Stretch.", when: { at: 1_000 }, missed: "once" as const };
  expect(tickMessage({ job, tick: 1_000 })).toEqual({
    id: "scheduler:tool-schedule:c1:call-1:1000",
    channel: "scheduler",
    conversationId: "telegram:12345",
    actor: { id: "tool-schedule:c1:call-1" },
    text: "Stretch.",
  });
});

test("its key's actor admits only a tick for its own key: one for another key, or no tick, is ignored", async () => {
  const asked: string[] = [];
  let mailbox: ActorMailbox | undefined;
  const fakes = defineComponent({
    name: "fakes-test",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      pikit.provide("scheduler", { handle() {} } as never);
      pikit.provide("agent.runtime", { dispatch: async () => ({ kind: "started" }) } as unknown as AgentRuntime);
      pikit.provide("conversations.registry", { get: async (key: string) => void asked.push(key) } as unknown as ConversationRegistry);
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [createMemoryMailbox(), fakes, schedulerAdmit], logger: silentLogger }).create();
  await app.start();
  try {
    const job = { id: "scheduler-routines:daily", key: "telegram:1", prompt: "Report.", when: { cron: "0 8 * * *", timezone: "UTC" }, missed: "once" };
    await mailbox?.send("telegram:2", TICK, { job, tick: 1_000 }, app.context());
    await mailbox?.send("telegram:1", TICK, { job: { id: "x" }, tick: 1_000 } as JsonValue, app.context());
    expect(asked).toEqual([]);
    await mailbox?.send("telegram:1", TICK, { job, tick: 1_000 }, app.context());
    expect(asked).toEqual(["telegram:1"]);
  } finally {
    await app.stop();
  }
});
