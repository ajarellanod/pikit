/**
 * tool-schedule: the agent schedules prompts in its own conversation, lists them and cancels them
 * (`schedule`, `listSchedules`, `cancelSchedule`), through `scheduler`. Each tick comes back to the
 * conversation as a message, and its answer to the chat (scheduler-admit).
 *
 * - **Its own conversation only.** A job's key is the key of the run's conversation's origin
 *   (`originOf(CONVERSATION)`): the conversation itself, or for a delegated agent the one the person
 *   talks in, since a delegated task's own key has no conversation to come back to. Its ticks are
 *   answered there, by that conversation's agent (scheduler-admit), not by the delegated one. Listing
 *   and cancelling see only the jobs this tool made for that key, from any conversation of the tree.
 *   Another conversation's job, or one a routine made, is "no such job" (its existence is not revealed).
 * - **Idempotent, so `replay: "safe"`.** A job's id is `tool-schedule:<conversation>:<call>`, the same
 *   when pi-durable runs an interrupted call again, and `scheduler` keeps a known id as it is.
 *   Cancelling twice is cancelling once; listing only reads.
 * - **Bounded.** At most `maxPerConversation` jobs per key (a tree of delegations shares its origin's).
 *
 * Targets: `server`, as scheduler-sql. It imports nothing platform-specific.
 */

import { type AppContext, BACKGROUND_CONTEXT, type Context, defineComponent } from "@pikit/core";
import { CONVERSATION, originOf } from "@pikit/contracts";
import { defineTool, type ToolRegistration } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";
import type { ScheduledJobState, Scheduler, ScheduleWhen } from "./contract.ts";

/** The prefix of every job id it makes: its own, never another component's. */
export const JOB_PREFIX = "tool-schedule:";
export const SCHEDULE_TOOL = "schedule";
export const LIST_TOOL = "listSchedules";
export const CANCEL_TOOL = "cancelSchedule";

const Config = Type.Object({
  /** How many scheduled prompts one conversation may have at once. */
  maxPerConversation: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
});
export type ScheduleToolConfig = Static<typeof Config>;

/** An ISO 8601 date-time with its offset (`Z` or `+02:00`): never a server's local time. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** One job, as the model reads it. */
export function describeJob(job: ScheduledJobState): string {
  const when = "at" in job.when ? "once" : `cron "${job.when.cron}" (${job.when.timezone})`;
  return `${job.id}: next ${new Date(job.next).toISOString()}, ${when}, missed: ${job.missed}: ${JSON.stringify(job.prompt.length > 200 ? `${job.prompt.slice(0, 200)}…` : job.prompt)}`;
}

/** The three tools over `scheduler`; `within` gives a run's context the App's (clock, logger). */
export function createScheduleTools(scheduler: () => Scheduler, within: (context: Context) => AppContext, config: ScheduleToolConfig): ToolRegistration[] {
  const keyOf = (context: Context): string => {
    const conversation = context.value(CONVERSATION);
    if (conversation === undefined) throw new Error("this tool runs only in a conversation's run");
    // Where its ticks come back: a delegated task's key has no conversation a tick could enter.
    return originOf(conversation).key;
  };

  const schedule = defineTool({
    name: SCHEDULE_TOOL,
    description:
      "Schedules a prompt that comes back to you in this conversation, as a message from the scheduler, once at a time (at) or repeatedly (cron); " +
      "your answer to it is sent to this chat. Write the prompt as the instruction to follow then, with everything it needs. A time already past runs at once. " +
      "On a task another agent delegated to you, it comes back instead to the conversation the person talks in, and that conversation's agent answers it: write it for that agent.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 4_000, description: "What to do at each run." }),
      at: Type.Optional(Type.String({ description: "Once, at this ISO 8601 date-time with its offset: 2030-05-01T09:00:00+02:00." })),
      cron: Type.Optional(Type.String({ description: 'Repeatedly, at each match of 5 cron fields (minute hour day month weekday): "0 8 * * 1-5".' })),
      timezone: Type.Optional(Type.String({ description: 'The IANA zone of cron: "Europe/Madrid". Default UTC.' })),
      missed: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("skip")], { description: "A run missed while the service was down: once (default) runs it late, once; skip drops it." })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const key = keyOf(context);
      const ctx = within(context);
      if ((args.at === undefined) === (args.cron === undefined)) throw new Error("give either at (once) or cron (repeatedly)");
      let when: ScheduleWhen;
      if (args.at !== undefined) {
        if (args.timezone !== undefined) throw new Error("timezone goes with cron; at carries its own offset");
        const at = Date.parse(args.at);
        if (!ISO_WITH_OFFSET.test(args.at) || Number.isNaN(at)) throw new Error(`at must be an ISO 8601 date-time with its offset (2030-05-01T09:00:00+02:00), got "${args.at}"`);
        when = { at };
      } else when = { cron: args.cron as string, timezone: args.timezone ?? "UTC" };
      const id = `${JOB_PREFIX}${api.conversationId}:${api.callId}`;
      const existing = await scheduler().get(id, ctx);
      if (existing === undefined) {
        const mine = await scheduler().list({ key, prefix: JOB_PREFIX, limit: config.maxPerConversation }, ctx);
        if (mine.length >= config.maxPerConversation) throw new Error(`this conversation has ${mine.length} scheduled prompts, the most allowed: cancel one first`);
      }
      const job = existing ?? (await scheduler().schedule({ id, key, prompt: args.prompt, when, missed: args.missed ?? "once" }, ctx));
      if (job === undefined) return { output: [{ type: "text", text: `Scheduled (id ${id}); it has run already.` }] };
      return { output: [{ type: "text", text: `Scheduled. ${describeJob(job)}` }] };
    },
  });

  const list = defineTool({
    name: LIST_TOOL,
    description: "Lists the prompts scheduled in this conversation (with the schedule tool), with their ids and next runs.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, _api, context) {
      const mine = await scheduler().list({ key: keyOf(context), prefix: JOB_PREFIX, limit: config.maxPerConversation }, within(context));
      return { output: [{ type: "text", text: mine.length === 0 ? "Nothing is scheduled in this conversation." : mine.map(describeJob).join("\n") }] };
    },
  });

  const cancel = defineTool({
    name: CANCEL_TOOL,
    description: "Cancels a prompt scheduled in this conversation, by its id (listSchedules shows them).",
    parameters: Type.Object({ id: Type.String({ minLength: 1, description: "The scheduled prompt's id." }) }),
    replay: "safe",
    async execute(args, _api, context) {
      const key = keyOf(context);
      const ctx = within(context);
      const job = args.id.startsWith(JOB_PREFIX) ? await scheduler().get(args.id, ctx) : undefined;
      if (job === undefined || job.key !== key) throw new Error(`no prompt with the id "${args.id}" is scheduled in this conversation`);
      await scheduler().cancel(args.id, ctx);
      return { output: [{ type: "text", text: `Cancelled ${args.id}.` }] };
    },
  });

  return [schedule, list, cancel] as unknown as ToolRegistration[];
}

export default defineComponent({
  name: "tool-schedule",
  config: Config,
  setup(pikit, config) {
    const scheduler = pikit.use("scheduler");
    let app: AppContext | undefined;
    const within = (context: Context): AppContext => {
      if (app === undefined) throw new Error("tool-schedule: used while the App is not running");
      return app.derive(() => context);
    };
    const [schedule, list, cancel] = createScheduleTools(() => scheduler.get(), within, config) as [ToolRegistration, ToolRegistration, ToolRegistration];
    pikit.provideKeyed("agent.tool", SCHEDULE_TOOL, { ...schedule, summary: "Schedules a prompt in this conversation, once or on a cron schedule" });
    pikit.provideKeyed("agent.tool", LIST_TOOL, { ...list, summary: "Lists the prompts scheduled in this conversation" });
    pikit.provideKeyed("agent.tool", CANCEL_TOOL, { ...cancel, summary: "Cancels a prompt scheduled in this conversation" });
    return {
      start(ctx) {
        app = ctx.derive(() => BACKGROUND_CONTEXT);
      },
      stop() {
        app = undefined;
      },
    };
  },
});
