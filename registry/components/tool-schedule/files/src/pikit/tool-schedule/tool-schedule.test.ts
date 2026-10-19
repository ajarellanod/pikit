/**
 * tool-schedule's tests, copied with it: the three tools in a started App over an in-memory
 * `scheduler`, called as a run calls them (`CONVERSATION` in their context). The tools through
 * runtime-pi, with scheduler-sql and the ticks coming back, are scheduler-admit's `app.test.ts` in the
 * registry.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { CONVERSATION } from "@pikit/contracts";
import type { ToolRegistration } from "@pikit/pi-adapter/tools";
import type { ScheduledJobState, Scheduler } from "./contract.ts";
import toolSchedule, { CANCEL_TOOL, JOB_PREFIX, LIST_TOOL, SCHEDULE_TOOL } from "./index.ts";

/** `scheduler` in memory: what the tools read and write. */
function memoryScheduler(): Scheduler & { jobs: Map<string, ScheduledJobState> } {
  const jobs = new Map<string, ScheduledJobState>();
  return {
    jobs,
    async schedule(job) {
      const stored = jobs.get(job.id) ?? { ...job, next: "at" in job.when ? job.when.at : Date.UTC(2030, 0, 1, 8) };
      jobs.set(job.id, stored);
      return stored;
    },
    get: async (id) => jobs.get(id),
    list: async (query) =>
      [...jobs.values()]
        .filter((job) => (query.key === undefined || job.key === query.key) && (query.prefix === undefined || job.id.startsWith(query.prefix)))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, query.limit),
    cancel: async (id) => void jobs.delete(id),
    handle() {},
  };
}

async function started(config: Record<string, unknown> = {}) {
  const scheduler = memoryScheduler();
  let tools: ((name: string) => ToolRegistration) | undefined;
  const app = await defineApp({
    components: [
      defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", scheduler) }),
      toolSchedule,
      defineComponent({
        name: "tools-test",
        setup(pikit) {
          const keyed = pikit.useKeyed("agent.tool");
          return { start: () => void (tools = (name) => keyed.get(name) as ToolRegistration) };
        },
      }),
    ],
    config: { "tool-schedule": config },
    logger: silentLogger,
  }).create();
  await app.start();
  /** Calls `tool` in the run of conversation `key` (pi-durable's conversation `c-<key>`), as call `callId`. */
  const call = async (key: string, tool: string, args: unknown, callId = "call-1") => {
    const context = withContextValue(CONVERSATION, { key, agent: "assistant", conversationId: `c-${key}` }, BACKGROUND_CONTEXT);
    const api = { taskId: "t1", conversationId: `c-${key}`, callId };
    try {
      const result = await (tools as (name: string) => ToolRegistration)(tool).execute(args as never, api as never, context as never);
      return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return { scheduler, call, stop: () => app.stop() };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", memoryScheduler()) }), toolSchedule], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "tool-schedule")).toMatchObject({ provides: ["agent.tool"], requires: ["scheduler"], optional: [] });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ [SCHEDULE_TOOL]: "tool-schedule", [LIST_TOOL]: "tool-schedule", [CANCEL_TOOL]: "tool-schedule" });
});

test("schedule keeps a job in the run's conversation, under the call's id: the same call again is the same job", async () => {
  const s = await started();
  const args = { prompt: "Remind me to stretch", at: "2030-01-01T09:00:00+01:00" };
  expect(await s.call("chat:1", SCHEDULE_TOOL, args)).toStartWith(`Scheduled. ${JOB_PREFIX}c-chat:1:call-1: next 2030-01-01T08:00:00.000Z, once`);
  expect(await s.call("chat:1", SCHEDULE_TOOL, args)).toStartWith(`Scheduled. ${JOB_PREFIX}c-chat:1:call-1`);
  await s.call("chat:1", SCHEDULE_TOOL, { prompt: "Daily summary", cron: "0 8 * * *", timezone: "Europe/Madrid", missed: "skip" }, "call-2");
  expect([...s.scheduler.jobs.values()].map(({ id, key, prompt, when, missed }) => ({ id, key, prompt, when, missed }))).toEqual([
    { id: `${JOB_PREFIX}c-chat:1:call-1`, key: "chat:1", prompt: "Remind me to stretch", when: { at: Date.UTC(2030, 0, 1, 8) }, missed: "once" },
    { id: `${JOB_PREFIX}c-chat:1:call-2`, key: "chat:1", prompt: "Daily summary", when: { cron: "0 8 * * *", timezone: "Europe/Madrid" }, missed: "skip" },
  ]);
  await s.stop();
});

test("schedule refuses a time without its offset, both at and cron, neither, and more than maxPerConversation", async () => {
  const s = await started({ maxPerConversation: 1 });
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x", at: "2030-01-01T09:00:00" })).toStartWith("failed: at must be an ISO 8601 date-time with its offset");
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x", at: "2030-01-01T09:00:00Z", cron: "0 8 * * *" })).toBe("failed: give either at (once) or cron (repeatedly)");
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x" })).toBe("failed: give either at (once) or cron (repeatedly)");
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x", at: "2030-01-01T09:00:00Z", timezone: "UTC" })).toStartWith("failed: timezone goes with cron");
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x", at: "2030-01-01T09:00:00Z" }, "a")).toStartWith("Scheduled.");
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "y", at: "2030-01-01T09:00:00Z" }, "b")).toStartWith("failed: this conversation has 1 scheduled prompts");
  // Its own call again is not a new job: still answered.
  expect(await s.call("chat:1", SCHEDULE_TOOL, { prompt: "x", at: "2030-01-01T09:00:00Z" }, "a")).toStartWith("Scheduled.");
  expect(s.scheduler.jobs.size).toBe(1);
  await s.stop();
});

test("another conversation's jobs, and a routine's, are neither listed nor cancelled", async () => {
  const s = await started();
  await s.call("chat:1", SCHEDULE_TOOL, { prompt: "mine", at: "2030-01-01T09:00:00Z" });
  await s.call("chat:2", SCHEDULE_TOOL, { prompt: "theirs", at: "2030-01-01T09:00:00Z" });
  await s.scheduler.schedule({ id: "scheduler-routines:daily", key: "chat:1", prompt: "routine", when: { cron: "0 8 * * *", timezone: "UTC" }, missed: "once" }, undefined as never);
  const listed = await s.call("chat:1", LIST_TOOL, {});
  expect(listed).toContain(`${JOB_PREFIX}c-chat:1:call-1`);
  expect(listed).not.toContain("theirs");
  expect(listed).not.toContain("routine");
  const theirs = `${JOB_PREFIX}c-chat:2:call-1`;
  expect(await s.call("chat:1", CANCEL_TOOL, { id: theirs })).toBe(`failed: no prompt with the id "${theirs}" is scheduled in this conversation`);
  expect(await s.call("chat:1", CANCEL_TOOL, { id: "scheduler-routines:daily" })).toStartWith("failed: no prompt with the id");
  expect([...s.scheduler.jobs.keys()].sort()).toEqual([`${JOB_PREFIX}c-chat:1:call-1`, theirs, "scheduler-routines:daily"].sort());
  expect(await s.call("chat:1", CANCEL_TOOL, { id: `${JOB_PREFIX}c-chat:1:call-1` })).toBe(`Cancelled ${JOB_PREFIX}c-chat:1:call-1.`);
  expect(await s.call("chat:1", LIST_TOOL, {})).toBe("Nothing is scheduled in this conversation.");
  await s.stop();
});
