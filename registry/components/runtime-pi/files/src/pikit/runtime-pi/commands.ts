/**
 * runtime-pi's slash commands for the people in a chat (`audience: "user"`: anyone the channel admits
 * there may type them), each acting on the conversation it is typed in, and only on it:
 *
 * - `/stop`: stops the run going (`agent.runtime`'s `abort`), and the messages waiting for the next one;
 *   background tasks go on. Nothing running: it says so.
 * - `/status`: the conversation's agent, whether it runs or is idle, how many messages wait, and how
 *   many background tasks run: what pi-durable's records say, read without writing.
 * - `/tasks`: the background tasks this conversation delegated (tool-delegate's `delegate` with
 *   `wait: false`): each one's id, agent, status, when it started and its latest step.
 * - `/cancel <id>`: stops one of them, as the agent's `delegate_cancel` does: the conversation is told
 *   once that it stopped. An id another conversation started is not found here.
 *
 * The tasks are the runtime's (`DurableRuntime.delegations`, scoped to the conversation given), so these
 * live here and not in tool-delegate: runtime-pi uses every `agent.tool`, so a tool's component cannot use
 * what runtime-pi provides (a dependency cycle). In Google Chat each thread is a conversation: `/tasks`
 * there lists that thread's tasks only.
 */

import type { AppContext } from "@pikit/core";
import type { AgentCommand, ConversationRef } from "@pikit/contracts";
import type { DurableRuntime } from "@pikit/pi-adapter";
import type { BackgroundDelegation, DelegationProgress, DelegationStep } from "@pikit/pi-adapter/tools";

/** How long ago `at` was, from `now` (ms since the epoch), in words. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const [amount, unit] = seconds < 120 ? [seconds, "second"] : seconds < 7200 ? [Math.round(seconds / 60), "minute"] : [Math.round(seconds / 3600), "hour"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** A step on one line, as a person reads it. */
const stepLine = (step: DelegationStep) => (step.kind === "text" ? `wrote: ${step.text.replace(/\s+/g, " ")}` : `called ${step.name} (${step.status})`);

/** One task as `/tasks` shows it: a running one with when it started and its latest step. */
function taskLine(task: BackgroundDelegation, progress: DelegationProgress | undefined, now: number): string {
  const head = `- ${task.id}: ${task.agent}, ${task.status}`;
  if (progress === undefined) return head;
  const started = progress.startedAt === undefined ? "" : `, started ${ago(progress.startedAt, now)}`;
  const latest = progress.steps.at(-1);
  return `${head}${started}${latest === undefined ? "" : `; latest step${progress.updatedAt === undefined ? "" : ` ${ago(progress.updatedAt, now)}`}: ${stepLine(latest)}`}`;
}

/**
 * The commands, over the runtime `current()` gives (the App's, while it runs). `drive` asks for whatever
 * drives runs (with `wakeups`, a wakeup), after a command left work to do: a stopped task's report.
 */
export function userCommands(current: () => DurableRuntime, drive: (ctx: AppContext) => Promise<void>): Record<string, AgentCommand> {
  const running = async (conversation: ConversationRef, ctx: AppContext) => (await current().delegations.list(conversation, ctx)).filter((task) => task.status === "running").length;
  return {
    stop: {
      description: "Stop what the agent is doing now",
      audience: "user",
      async run(conversation, _args, ctx) {
        const status = await current().status(conversation, ctx);
        if (!status.running && status.waiting === 0) return { text: "Nothing is running." };
        await current().abort(conversation, ctx);
        const waiting = status.waiting === 0 ? "" : ` (and ${plural(status.waiting, "message")} that waited)`;
        return { text: `Stopped${waiting}. Background tasks go on: /tasks lists them.` };
      },
    },
    status: {
      description: "What the agent is doing: running or idle, messages waiting",
      audience: "user",
      async run(conversation, _args, ctx) {
        const [status, tasks] = await Promise.all([current().status(conversation, ctx), running(conversation, ctx)]);
        const state = status.running ? "running" : "idle";
        const waiting = status.waiting === 0 ? "" : `, ${plural(status.waiting, "message")} waiting`;
        const background = tasks === 0 ? "" : `; ${plural(tasks, "background task")} running (/tasks)`;
        return { text: `${conversation.agent}: ${state}${waiting}${background}.` };
      },
    },
    tasks: {
      description: "The background tasks of this conversation",
      audience: "user",
      async run(conversation, _args, ctx) {
        const tasks = await current().delegations.list(conversation, ctx);
        if (tasks.length === 0) return { text: "No background tasks in this conversation." };
        const now = ctx.clock.now();
        const lines = await Promise.all(
          tasks.map(async (task) => {
            const progress = task.status === "running" ? await current().delegations.progress(conversation, task.id, ctx) : undefined;
            return taskLine(task, progress === "not_found" ? undefined : progress, now);
          }),
        );
        return { text: `Background tasks:\n${lines.join("\n")}` };
      },
    },
    cancel: {
      description: "Stop a background task of this conversation",
      argumentHint: "<id>",
      audience: "user",
      async run(conversation, args, ctx) {
        if (args === "") throw new Error("Write the task's id: /cancel <id> (/tasks lists them)");
        const status = await current().delegations.cancel(conversation, args, ctx);
        if (status === "not_found") throw new Error(`There is no task "${args}" in this conversation (/tasks lists them).`);
        if (status !== "aborted") return { text: `The task "${args}" had already ended (${status}): nothing to stop.` };
        await drive(ctx);
        return { text: `The task "${args}" is stopped.` };
      },
    },
  };
}
