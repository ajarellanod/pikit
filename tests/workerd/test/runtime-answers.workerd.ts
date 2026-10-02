/**
 * runtime-pi's `agent.submissions` in a Durable Object, on pi-durable over `storage-do`:
 *
 * - The answers log (`@pikit/pi-adapter`'s `answers.ts`) under the feed suite (SPEC K3), with pruning
 *   and restarts (a restart is a new app over the same object), each case in an object of its own.
 * - Reconciliation across an eviction, in deployment-cloudflare's real `Conversation` class
 *   (`PlatformConversation`): a run settles in pi-durable while its log cannot be written (a SQLite
 *   trigger refuses the append, as a process killed between the two would leave it), the object is
 *   evicted, and the next instance, started by its alarm, logs and announces the run once.
 *
 * `Date` is a day ahead in the eviction test, so the alarms runtime-pi asks for never fire on their own
 * and each is fired by the test, between which the object is evicted (AGENTS.md, the workerd lesson).
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, ConversationRef, RunSettlement, SqlDatabase } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createFeedConformance, withWorkersHost } from "@pikit/contracts/testing";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { createAnswerLog } from "../../../packages/pi-adapter/src/answers.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

/** One "process" over the object the case runs in: storage-do's `storage.sql`, and its stop. */
async function openDatabase(): Promise<{ database: SqlDatabase; close(): Promise<void> }> {
  let database: SqlDatabase | undefined;
  const reader = defineComponent({
    name: "storage-reader",
    setup(pikit) {
      const sql = pikit.use("storage.sql");
      return { start: () => void (database = sql.get()) };
    },
  });
  const app = await defineApp({ components: [...withWorkersHost(objectHost(), [storageDo]), reader], logger: silentLogger }).create();
  await app.start();
  if (database === undefined) throw new Error("storage.sql was not resolved");
  return { database, close: () => app.stop() };
}

const run = (requestId: string): RunSettlement => ({
  conversation: { key: "test:c1", agent: "scripted", conversationId: "1" },
  requestId,
  requestIds: [requestId],
  kind: "completed",
  text: `answer to ${requestId}`,
});

for (const c of createFeedConformance<RunSettlement>(
  async () => {
    let opened = await openDatabase();
    let log = createAnswerLog(opened.database);
    await log.ensure();
    let n = 0;
    return {
      feed: () => ({ read: (after, limit) => log.read(after, limit) }),
      async commit() {
        const id = `run-${++n}`;
        await log.append([{ key: `1:s${n}`, run: run(id) }], Date.now());
        return id;
      },
      identify: (fact) => fact.requestId,
      prune: () => log.prune(Date.now() + 1),
      async restart() {
        await opened.close();
        opened = await openDatabase();
        log = createAnswerLog(opened.database);
        await log.ensure();
      },
      dispose: () => opened.close(),
    };
  },
  { prunes: true, restarts: true },
)) {
  it(`runtime-pi's answers log over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** The scripted agent and model: each run answers `answer: <message>`. */
function model(): ComponentDefinition[] {
  const agent = scriptedAgent(holdTool(async () => "released"));
  const provider = scriptedProvider();
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/**
 * A channel's object half: admits its messages to the runtime; every answer, from any instance, goes
 * to `answers`. Its conversation is made at the first message and kept (as `conversations.registry`
 * would) in this module, which outlives the object's instances (one isolate).
 */
const conversationOf = new Map<string, string>();
function channelActor(answers: (string | undefined)[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.use("agent.submissions");
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversationId = conversationOf.get(key) ?? (await conversations.get().create(ctx));
            conversationOf.set(key, conversationId);
            const conversation: ConversationRef = { key, agent: "scripted", conversationId };
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
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

/** Runs `query` on the object's SQL, from outside any event of its App. */
const sql = (key: string, query: string) => runInDurableObject(objectOf(key), async (_instance, state) => state.storage.sql.exec(query).toArray());

/** Fires the object's alarm until `probe` holds. */
const alarmsUntil = (key: string, probe: () => Promise<void> | void) =>
  vi.waitFor(
    async () => {
      await runDurableObjectAlarm(objectOf(key));
      await probe();
    },
    { timeout: 10_000, interval: 200 },
  );

it("a run that settled while its log could not be written, then the object evicted: the next instance logs and announces it once", async () => {
  const answers: (string | undefined)[] = [];
  composeObjects([storageDo, platformCloudflare, ...model(), runtimePi, channelActor(answers)]);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(key, { id: "m0", text: "hello" });
    await alarmsUntil(key, () => expect(answers).toEqual(["answer: hello"]));

    // From now on the log refuses appends: the next run settles in pi-durable and is never logged.
    await sql(key, "CREATE TABLE test_crash (armed INTEGER)");
    await sql(key, "INSERT INTO test_crash VALUES (1)");
    await sql(key, "CREATE TRIGGER test_crash_append BEFORE INSERT ON runtime_pi_answers WHEN EXISTS (SELECT 1 FROM test_crash) BEGIN SELECT RAISE(ABORT, 'the process died'); END");
    await worker.send(key, { id: "m1", text: "again" });
    // pi-durable keeps the request id as JSON.
    await alarmsUntil(key, async () => expect(await sql(key, `SELECT status FROM submissions WHERE request_id = '"m1"'`)).toEqual([{ status: "done" }]));
    // Whatever alarm is left runs out: the settlement stays unlogged and unannounced.
    await runDurableObjectAlarm(objectOf(key));
    expect(answers).toEqual(["answer: hello"]);
    expect((await sql(key, "SELECT request_ids FROM runtime_pi_answers ORDER BY seq")).map((row) => row.request_ids)).toEqual(['["m0"]']);

    // Between two alarms: the instance goes; the storage, and the run's end in pi-durable, stay.
    await sql(key, "DELETE FROM test_crash");
    await evictDurableObject(objectOf(key));
    await runInDurableObject(objectOf(key), (_instance, state) => state.storage.setAlarm(Date.now()));
    // The next instance starts its App at its alarm; opening pi-durable reconciles the conversation.
    await alarmsUntil(key, () => expect(answers).toEqual(["answer: hello", "answer: again"]));
    expect((await sql(key, "SELECT request_ids, text FROM runtime_pi_answers ORDER BY seq")).map((row) => [row.request_ids, row.text])).toEqual([
      ['["m0"]', "answer: hello"],
      ['["m1"]', "answer: again"],
    ]);

    // Delivered again: a duplicate, and nothing is logged or announced twice.
    await worker.send(key, { id: "m1", text: "again" });
    await runDurableObjectAlarm(objectOf(key));
    expect(answers).toEqual(["answer: hello", "answer: again"]);
    expect(await sql(key, "SELECT COUNT(*) AS n FROM runtime_pi_answers")).toEqual([{ n: 2 }]);
  } finally {
    await worker.stop();
  }
});
