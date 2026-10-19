/**
 * scheduler-admit's tests, copied with it: what setup declares, and the message a tick becomes. Ticks
 * admitted through runtime-pi, answered and deduplicated, are `app.test.ts` beside `files/` in the registry.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import schedulerAdmit, { tickMessage } from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const fakes = defineComponent({
    name: "fakes-test",
    setup(pikit) {
      pikit.provide("scheduler", {} as never);
      pikit.provide("agent.runtime", {} as never);
      pikit.provide("conversations.registry", {} as never);
    },
  });
  const app = await defineApp({ components: [fakes, schedulerAdmit], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-admit")).toMatchObject({
    provides: [],
    requires: ["scheduler", "agent.runtime", "conversations.registry"],
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
