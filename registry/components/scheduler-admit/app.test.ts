/**
 * The scheduler in a real App, on a manual clock: runtime-pi runs the agent on a SQLite file (model
 * `faux/scripted`: `call: <tool> <json>` calls a tool, anything else is answered `answer: <message>`),
 * conversations-kv over storage-kv-sql keeps the keys, router-basic routes, and a test channel admits
 * people's messages. scheduler-sql keeps the jobs, scheduler-admit admits their ticks, tool-schedule and
 * scheduler-routines make them.
 *
 * What it checks: a tick is a message in the job's conversation, from the scheduler (never a person),
 * answered in the `answers` feed under the conversation's key (what its channel delivers); a restart
 * between ticks loses none and duplicates none, even a tick delivered twice; a job whose key has no
 * conversation admits nothing and creates none; a conversation cannot cancel another's job.
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { admitInbound, defineAgent, type InboundMessage, type RunSettlement, type SqlDatabase } from "@pikit/contracts";
import { createMemoryWakeups } from "@pikit/contracts/testing";
import { createManualClock } from "@pikit/core/testing";
import { scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import conversationsKv from "../conversations-kv/files/src/pikit/conversations-kv/index.ts";
import routerBasic from "../router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import schedulerRoutines from "../scheduler-routines/files/src/pikit/scheduler-routines/index.ts";
import schedulerSql, { TABLE } from "../scheduler-sql/files/src/pikit/scheduler-sql/index.ts";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolSchedule, { CANCEL_TOOL, JOB_PREFIX, SCHEDULE_TOOL } from "../tool-schedule/files/src/pikit/tool-schedule/index.ts";
import type { Scheduler } from "./files/src/pikit/scheduler-admit/contract.ts";
import schedulerAdmit, { SCHEDULER_CHANNEL } from "./files/src/pikit/scheduler-admit/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2030-01-01T00:00:00Z. */
const START = Date.UTC(2030, 0, 1);

type Routine = { name: string; key: string; prompt: string; cron: string; timezone?: string; missed?: "once" | "skip" };

/** A world over one directory: Apps that restart over its database, on one manual clock. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-scheduler-app-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = createManualClock(START);
  /** Every message routing saw, across Apps. */
  const routed: InboundMessage[] = [];
  let app: App | undefined;
  let reached: { ctx: AppContext; admit(message: InboundMessage): Promise<string>; answers(): Promise<RunSettlement[]>; scheduler: Scheduler; sql: SqlDatabase; conversation(key: string): Promise<unknown> } | undefined;

  const stop = async () => {
    const running = app;
    app = undefined;
    await running?.stop();
  };
  cleanup.push(stop);

  const boot = async (routines: Routine[] = []) => {
    await stop();
    const channel = defineComponent({
      name: "channel-test",
      setup(pikit) {
        const conversations = pikit.use("conversations.registry");
        const runtime = pikit.use("agent.runtime");
        const submissions = pikit.use("agent.submissions");
        const scheduler = pikit.use("scheduler");
        const sql = pikit.use("storage.sql");
        pikit.pipeline("route.resolve", (value) => (routed.push(value.message), value), { id: "recorder", priority: 100 });
        return {
          start(ctx) {
            reached = {
              ctx,
              admit: async (message) => (await admitInbound(ctx, message, { conversations: conversations.get(), runtime: runtime.get(), key: `test:${message.conversationId}` })).kind,
              answers: async () => (await submissions.get().answers.read(undefined, 100)).items.map((item) => item.fact),
              scheduler: scheduler.get(),
              sql: sql.get(),
              conversation: (key) => conversations.get().get(key, ctx),
            };
          },
        };
      },
    });
    const components = [
      sqliteStorage(join(dir, "pikit.db")),
      storageKvSql,
      createMemoryWakeups(),
      defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted", tools: [SCHEDULE_TOOL, CANCEL_TOOL] })) }),
      defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider()) }),
      runtimePi,
      conversationsKv,
      routerBasic,
      schedulerSql,
      schedulerAdmit,
      toolSchedule,
      schedulerRoutines,
      channel,
    ];
    const config = { "router-basic": { defaultAgent: "assistant" }, "scheduler-routines": { routines } };
    app = await defineApp({ components, config, clock, logger: silentLogger }).create();
    await app.start();
    return live();
  };
  const live = () => reached ?? (() => { throw new Error("the test channel has not started"); })();

  /** The settlements answering `requestId`, once there is one. */
  const answered = async (requestId: string): Promise<RunSettlement[]> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await live().answers()).filter((answer) => answer.requestIds.includes(requestId));
      if (found.length > 0) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for the answer to ${requestId}; answers: ${JSON.stringify((await live().answers()).map((a) => a.requestIds))}`);
      await Bun.sleep(5);
    }
  };
  /** Moves the clock on, and lets the wakeups it ran admit their messages. */
  const advance = async (ms: number) => {
    await clock.advance(ms);
    for (let i = 0; i < 20; i++) await Bun.sleep(1);
  };
  /** A person's message on the test channel, in the chat `chat`; resolves once it is answered. */
  const say = async (chat: string, id: string, text: string) => {
    expect(await live().admit({ id, channel: "test", conversationId: chat, actor: { id: "alice" }, text })).toBe("admitted");
    return answered(id);
  };
  return { clock, routed, boot, stop, live, answered, advance, say };
}

test("a tick of an at job (from the agent's tool) and of a routine is a message from the scheduler in the conversation, answered under its key", async () => {
  const w = world();
  const routine = { name: "daily", key: "test:1", prompt: "Summarize the day.", cron: "0 8 * * *", timezone: "Europe/Madrid" };
  await w.boot([routine]);
  await w.say("1", "m1", "hello");
  // The agent schedules a reminder in its own conversation for 01:00 UTC.
  await w.say("1", "m2", `call: ${SCHEDULE_TOOL} ${JSON.stringify({ prompt: "Remind me to stretch.", at: "2030-01-01T02:00:00+01:00" })}`);
  const [reminder, ...others] = await w.live().scheduler.list({ prefix: JOB_PREFIX, limit: 10 }, w.live().ctx);
  expect(others).toEqual([]);
  expect(reminder).toMatchObject({ key: "test:1", prompt: "Remind me to stretch.", next: START + HOUR });

  await w.advance(HOUR - 1);
  expect(w.routed.map((m) => m.channel)).toEqual(["test", "test"]);
  await w.advance(1);
  const reminded = `${SCHEDULER_CHANNEL}:${reminder?.id}:${START + HOUR}`;
  const [answer] = await w.answered(reminded);
  expect(answer).toMatchObject({ kind: "completed", text: "answer: Remind me to stretch.", conversation: { key: "test:1", agent: "assistant" } });
  // From the scheduler, as the job: never as alice.
  expect(w.routed.at(-1)).toMatchObject({ id: reminded, channel: SCHEDULER_CHANNEL, conversationId: "test:1", actor: { id: reminder?.id } });
  expect(await w.live().scheduler.get(reminder?.id as string, w.live().ctx)).toBeUndefined();

  // The routine: 08:00 in Madrid is 07:00 UTC in January.
  await w.advance(6 * HOUR);
  const summarized = `${SCHEDULER_CHANNEL}:scheduler-routines:daily:${START + 7 * HOUR}`;
  expect((await w.answered(summarized))[0]).toMatchObject({ text: "answer: Summarize the day.", conversation: { key: "test:1" } });
  // One conversation all along: the person's, recorded with the test channel.
  expect(await w.live().conversation("test:1")).toMatchObject({ key: "test:1", channel: "test", conversationId: answer?.conversation.conversationId });
});

test("a restart between ticks loses none and duplicates none, even a tick delivered twice", async () => {
  const w = world();
  const hourly = { name: "hourly", key: "test:1", prompt: "Check in.", cron: "0 * * * *", timezone: "UTC" };
  await w.boot([hourly]);
  await w.say("1", "m1", "hello");
  await w.advance(HOUR);
  const first = `${SCHEDULER_CHANNEL}:scheduler-routines:hourly:${START + HOUR}`;
  await w.answered(first);

  // Down for two and a half hours: the ticks at 02:00 and 03:00 are missed, the earliest runs once.
  await w.stop();
  await w.advance(2 * HOUR + 30 * MINUTE);
  await w.boot([hourly]);
  const missed = `${SCHEDULER_CHANNEL}:scheduler-routines:hourly:${START + 2 * HOUR}`;
  await w.answered(missed);

  // A crash between the admission and the scheduler moving on: the same tick is delivered again.
  await w.live().sql.run(`UPDATE ${TABLE} SET next_at = ? WHERE id = ?`, [START + 2 * HOUR, "scheduler-routines:hourly"]);
  await w.boot([hourly]);
  await w.advance(30 * MINUTE);
  const next = `${SCHEDULER_CHANNEL}:scheduler-routines:hourly:${START + 4 * HOUR}`;
  await w.answered(next);

  const scheduled = (await w.live().answers()).flatMap((answer) => answer.requestIds).filter((id) => id.startsWith(`${SCHEDULER_CHANNEL}:`));
  expect(scheduled).toEqual([first, missed, next]);
  expect(w.routed.filter((m) => m.id === missed).length).toBe(2);
});

test("a job whose key has no conversation admits nothing and creates none", async () => {
  const w = world();
  await w.boot();
  const { scheduler, ctx } = w.live();
  await scheduler.schedule({ id: "test-job", key: "test:404", prompt: "Hello?", when: { at: START + MINUTE }, missed: "once" }, ctx);
  await w.advance(MINUTE);
  expect(await scheduler.get("test-job", ctx)).toBeUndefined();
  expect(w.routed).toEqual([]);
  expect(await w.live().conversation("test:404")).toBeUndefined();
});

test("a conversation cannot cancel another conversation's job", async () => {
  const w = world();
  await w.boot();
  await w.say("1", "m1", `call: ${SCHEDULE_TOOL} ${JSON.stringify({ prompt: "Mine.", cron: "0 8 * * *" })}`);
  const [job] = await w.live().scheduler.list({ prefix: JOB_PREFIX, limit: 10 }, w.live().ctx);
  await w.say("2", "m2", `call: ${CANCEL_TOOL} ${JSON.stringify({ id: job?.id })}`);
  expect(await w.live().scheduler.get(job?.id as string, w.live().ctx)).toMatchObject({ key: "test:1", prompt: "Mine." });
});
