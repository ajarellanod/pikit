/**
 * scheduler-sql, scheduler-admit, scheduler-routines and tool-schedule on Cloudflare.
 *
 * - The `scheduler` suite on scheduler-sql over storage-do (a real object's SQLite) and actors-do's
 *   `wakeups`, whose alarm is `simulatedObject`'s on the suite's manual clock (as actors-do's own
 *   wakeups suite runs); a restart is a second App over the same object.
 * - In deployment-cloudflare's `Conversation` class (`PlatformConversation`, `src/platform.ts`), each key
 *   an object running runtime-pi on `faux/scripted`, router-basic and the scheduler's components: the
 *   Worker's App starts scheduler-routines' Worker half, which has the routines' actor
 *   (`scheduler-routines:routines`) sync them from its config; its alarm (`Date` faked ahead, the alarms
 *   fired) sends the routine's tick to the chat's object, which admits and answers it. The agent's own
 *   `schedule` keeps its job in the chat's object, which answers its tick from its own alarm. A routine
 *   the scheduler refuses fails the Worker's start.
 */

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import { simulatedObject } from "../../../registry/components/actors-do/files/src/pikit/actors-do/object.test-support.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import schedulerAdmit from "../../../registry/components/scheduler-admit/files/src/pikit/scheduler-admit/index.ts";
import schedulerRoutines, { ROUTINES_KEY, worker as schedulerRoutinesWorker } from "../../../registry/components/scheduler-routines/files/src/pikit/scheduler-routines/index.ts";
import { createSchedulerConformance } from "../../../registry/components/scheduler-sql/files/src/pikit/scheduler-sql/conformance.ts";
import schedulerSql, { GRACE_MS, TABLE } from "../../../registry/components/scheduler-sql/files/src/pikit/scheduler-sql/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolSchedule from "../../../registry/components/tool-schedule/files/src/pikit/tool-schedule/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };
const object = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));

// The routines' actor is one object for every test: empty it, then reset every instance.
beforeEach(async () => {
  await runInDurableObject(object(ROUTINES_KEY), (_instance, state) => state.storage.deleteAll());
  await resetObjects();
});
afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

for (const c of createSchedulerConformance(
  () => {
    const simulated = simulatedObject((objectHost().object?.storage as DurableObjectStorage).sql);
    return { components: [...withWorkersHost(objectHost(), [storageDo]), ...withWorkersHost(simulated.host, [actorsDo]), simulated.component, schedulerSql], target: "durable" };
  },
  { graceMs: GRACE_MS },
)) {
  it(`scheduler-sql over storage-do and actors-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** The objects' App: the agent may schedule; each chat's messages through a channel's object half; answers in `answers`. */
function objects(answers: string[], routines: unknown[]): void {
  const fixtures = defineComponent({
    name: "fixtures-test",
    setup(pikit) {
      pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted", tools: ["schedule"] }));
      pikit.provideKeyed("model.provider", "faux", scriptedProvider());
    },
  });
  const channel = defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result: AppEvents["agent.settled"]) => void answers.push(`${result.conversation.key}: ${result.text}`));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversation = await registry.get().resolve(key, "assistant", { channel: "test" }, ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
        },
      };
    },
  });
  composeObjects([storageDo, storageKvSql, actorsDo, fixtures, runtimePi, conversationsKv, routerBasic, schedulerSql, schedulerAdmit, schedulerRoutines, toolSchedule, channel], {
    ...ACTORS,
    "router-basic": { defaultAgent: "assistant" },
    "scheduler-routines": { routines },
  });
}

/** The Worker's App: scheduler-routines' Worker half, and a mailbox to send the chat's messages. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "test-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, schedulerRoutinesWorker, probe], config: ACTORS, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return { app, send: (key: string, id: string, text: string) => (mailbox as ActorMailbox).send(key, "test.message", { id, text }, app.context()) };
}

/** The job ids an object keeps. */
const jobsOf = (key: string) =>
  runInDurableObject(object(key), (_instance, state) => state.storage.sql.exec(`SELECT id FROM ${TABLE} WHERE next_at IS NOT NULL ORDER BY id`).toArray().map((row) => String(row.id)));

/** Fires the objects' alarms until `answers` has `wanted`. */
const until = (keys: string[], answers: string[], wanted: string) =>
  vi.waitFor(
    async () => {
      for (const key of keys) await runDurableObjectAlarm(object(key));
      expect(answers).toContain(wanted);
    },
    { timeout: 10_000, interval: 100 },
  );

it("the Worker's start syncs the routines into their actor; its alarm sends a tick to the chat's object, which answers it; the agent's own job stays in the chat's object", async () => {
  const answers: string[] = [];
  const chatKey = `test:${crypto.randomUUID()}`;
  // The routine names the chat's key; the chat exists before its first tick (a scheduled prompt never starts one).
  objects(answers, [{ name: "daily", key: chatKey, prompt: "daily report", cron: "* * * * *", timezone: "UTC" }]);
  const worker = await workerApp();
  try {
    await worker.send(chatKey, "m1", "hello");
    await vi.waitFor(() => expect(answers).toContain(`${chatKey}: answer: hello`), { timeout: 10_000 });
    expect(await jobsOf(ROUTINES_KEY)).toEqual(["scheduler-routines:daily"]);

    // The agent schedules a prompt in its own conversation: its job is the chat's object's, not the routines' actor's.
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    await worker.send(chatKey, "m2", `call: schedule {"prompt":"stretch","at":"${at}"}`);
    await vi.waitFor(async () => expect((await jobsOf(chatKey)).filter((id) => id.startsWith("tool-schedule:"))).toHaveLength(1), { timeout: 10_000 });
    expect(await jobsOf(ROUTINES_KEY)).toEqual(["scheduler-routines:daily"]);

    // Past both: the routines' alarm sends the routine's tick, the chat's alarm runs the agent's own job.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000, shouldAdvanceTime: true });
    await until([ROUTINES_KEY, chatKey], answers, `${chatKey}: answer: daily report`);
    await until([chatKey], answers, `${chatKey}: answer: stretch`);
    expect((await jobsOf(chatKey)).filter((id) => id.startsWith("tool-schedule:"))).toEqual([]);
  } finally {
    await worker.app.stop();
  }
});

it("a routine the scheduler refuses fails the Worker's start, naming it", async () => {
  objects([], [{ name: "broken", key: "test:1", prompt: "never", cron: "61 * * * *", timezone: "UTC" }]);
  const failed = await workerApp().then(
    async (worker) => (await worker.app.stop(), "started"),
    (error: Error) => String((error.cause as Error | undefined)?.message ?? error.message),
  );
  expect(failed).toContain('scheduler-routines: the routine "broken" cannot be scheduled');
  expect(await jobsOf(ROUTINES_KEY)).toEqual([]);
});
