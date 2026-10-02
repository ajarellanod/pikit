/**
 * runtime-pi on Cloudflare, on pi-durable over `storage-do`.
 *
 * - The `agent.runtime` contract on `runtime-pi` over `storage-do` in a real SQLite-backed object, a
 *   worker that died mid-run included (a runtime closed while its tool runs, which leaves what a reset
 *   object leaves).
 * - A conversation object's App as a Cloudflare project composes it, in a real object of
 *   deployment-cloudflare's `Conversation` class (`PlatformConversation`, `src/platform.ts`):
 *   `storage-do` (pi-durable's tables), `platform-cloudflare` for `actor.inbox` and `wakeups`,
 *   `runtime-pi` driving its runs in wakeups, the scripted model, and a channel's object half that
 *   creates its conversation through `agent.conversations` and uses `wakeups` itself. The Worker's App
 *   sends a message by RPC; the run is driven in the object's real alarm, and answers. Then a run the
 *   object is evicted in the middle of is answered by the next instance, woken by its alarm; and a
 *   model error's backoff is the object's alarm, the object goes meanwhile, and the alarm answers.
 *
 * `Date` (the apps' clock: the tests and the objects share one isolate) is moved ahead by a test that
 * waits for a backoff, so the retry comes due without waiting it out.
 */

import { type ComponentDefinition, defineApp, defineComponent, BACKGROUND_CONTEXT, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, ConversationRef, SqlDatabase } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createAgentRuntimeConformance, withWorkersHost } from "@pikit/contracts/testing";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { createRuntimeFixture } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import runtimePi, { createRuntimePi, DRIVE } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

/** storage-do over the object the case runs in, and its `storage.sql` for a step outside any worker. */
function objectRecords() {
  const host = objectHost();
  return {
    components: withWorkersHost(host, [storageDo]),
    async open(): Promise<{ database: SqlDatabase; close(): Promise<void> }> {
      let database: SqlDatabase | undefined;
      const reader = defineComponent({
        name: "storage-reader",
        setup(pikit) {
          const sql = pikit.use("storage.sql");
          return { start: () => void (database = sql.get()) };
        },
      });
      const app = await defineApp({ components: [...withWorkersHost(host, [storageDo]), reader], logger: silentLogger }).create();
      await app.start();
      if (database === undefined) throw new Error("storage.sql was not resolved");
      return { database, close: () => app.stop() };
    },
  };
}

// The agent.runtime contract, each case in an object of its own.
for (const c of createAgentRuntimeConformance(() => createRuntimeFixture([createRuntimePi()], objectRecords()))) {
  it(`runtime-pi on storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** What the agent's `hold` does, per test: by default it returns at once. */
let holding: () => Promise<string> = async () => "released";
/** The first model call of a test fails with this provider error, when set (pi-durable retries a 503). */
let failFirst: string | undefined;

/** The scripted agent and model: each run answers `answer: <message>`; `hold` calls `holding`. */
function model(): ComponentDefinition[] {
  const agent = scriptedAgent(holdTool(() => holding()));
  const provider = scriptedProvider({
    fail: () => {
      const failing = failFirst;
      failFirst = undefined;
      return failing === undefined ? undefined : Promise.resolve(failing);
    },
  });
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/**
 * A channel's object half: creates its conversation through `agent.conversations` (the object's first
 * is pi-durable's root), admits its messages to the runtime, and uses `wakeups` itself. Every answer,
 * from whichever instance of the object, is pushed to `answers`.
 */
function channelActor(answers: (string | undefined)[], drives: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const wakeups = pikit.use("wakeups");
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            // One conversation per object: its id is the root's, the same at every message.
            const conversation: ConversationRef = { key, agent: "scripted", conversationId: await conversations.get().create(ctx) };
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

/** The Worker's App, which sends to the objects through `actor.mailbox`. */
async function workerApp() {
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
  return {
    send: (key: string, message: { id: string; text: string }) => mailbox?.send(key, "test.message", message, worker.context()),
    stop: () => worker.stop(),
  };
}

const DAY = 24 * 60 * 60 * 1_000;

const objectOf = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));

/** The drive's request row and the object's alarm, read in the object. */
const driveState = (key: string) =>
  runInDurableObject(objectOf(key), async (_instance, state) => ({
    drive: state.storage.sql.exec("SELECT time FROM platform_cloudflare_wakeups WHERE name = ?", DRIVE).toArray()[0]?.time as number | undefined,
    alarm: await state.storage.getAlarm(),
  }));

it("runtime-pi runs on platform-cloudflare's wakeups in a real object: a message sent from the Worker is answered in the object's alarm", async () => {
  const answers: (string | undefined)[] = [];
  const drives: string[] = [];
  composeObjects([storageDo, platformCloudflare, ...model(), runtimePi, channelActor(answers, drives)]);
  const worker = await workerApp();
  try {
    const key = `test:${crypto.randomUUID()}`;
    await worker.send(key, { id: "m1", text: "hello" });
    // Once the message was admitted, the run was left to the wakeup that drives it.
    expect(drives).toContain(DRIVE);
    await vi.waitFor(() => expect(answers).toEqual(["answer: hello"]), { timeout: 10_000 });
    // A second message, to the same conversation (the object's root).
    await worker.send(key, { id: "m2", text: "again" });
    await vi.waitFor(() => expect(answers).toEqual(["answer: hello", "answer: again"]), { timeout: 10_000 });
    // The object's alarm ran the drive handler, which resolved: its request is done.
    await vi.waitFor(async () => expect(await driveState(key)).toEqual({ drive: undefined, alarm: null }), { timeout: 10_000 });
  } finally {
    await worker.stop();
  }
});

it("a run the object is evicted in the middle of is answered by the next instance, woken by its alarm", async () => {
  const answers: (string | undefined)[] = [];
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  // The tool never returns in the first instance: the eviction ends it.
  holding = () => {
    held();
    return new Promise<string>(() => {});
  };
  // Short slices: the alarm that drives the run ends soon, and asks again, as on Cloudflare at its deadline.
  composeObjects([storageDo, platformCloudflare, ...model(), runtimePi, channelActor(answers, [])], { "platform-cloudflare": { sliceMs: 200 } });
  // A day ahead: the alarms runtime-pi asks for are a day after the real clock, so the runtime does not
  // fire them by itself, and the test fires each one.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(key, { id: "m1", text: "hold" });
    // The drive's alarm: the run reaches the tool; the slice ends with the run going, and asks again.
    expect(await runDurableObjectAlarm(objectOf(key))).toBe(true);
    await reached;
    holding = async () => "released";
    expect((await driveState(key)).drive).toBeDefined();

    // Between two of its alarms: the instance and its in-process work are gone, the storage stays.
    await evictDurableObject(objectOf(key));
    // The next instance: its alarm (the drive's request survives in the object's SQL) starts its App,
    // whose runtime finds the run open and continues it. The tool is not run again (replay unsafe): the
    // model gets an interrupted result, and answers.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(key));
        expect(answers).toEqual(["answer: hold"]);
      },
      { timeout: 10_000, interval: 200 },
    );
  } finally {
    holding = async () => "released";
    await worker.stop();
  }
});

it("a model error's backoff is the object's alarm: the object goes meanwhile, and the alarm at the retry time answers", async () => {
  const answers: (string | undefined)[] = [];
  failFirst = "503 Service Unavailable";
  const retryMs = 60_000;
  composeObjects([storageDo, platformCloudflare, ...model(), createRuntimePi({ settings: { retry: { baseDelayMs: retryMs } } }), channelActor(answers, [])]);
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    const before = Date.now();
    await worker.send(key, { id: "m1", text: "hello" });
    // The drive's slice: the model fails, and the backoff becomes the drive's request, and the alarm.
    // The runtime may fire the due alarm itself; one fired here before the retry only asks again.
    const due = await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(key));
        const { drive, alarm } = await driveState(key);
        expect(drive).toBeGreaterThanOrEqual(before + retryMs);
        expect(alarm).toBe(drive ?? null);
        return drive as number;
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(answers).toEqual([]);

    // The handler closed pi-durable inside its event (nothing in-process waits for the retry), so the
    // object can be evicted until its alarm.
    await evictDurableObject(objectOf(key));
    vi.useFakeTimers({ toFake: ["Date"], now: due + 1_000, shouldAdvanceTime: true });
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(key));
        expect(answers).toEqual(["answer: hello"]);
      },
      { timeout: 10_000, interval: 200 },
    );
  } finally {
    failFirst = undefined;
    await worker.stop();
  }
});
