/**
 * Delegation: a tool hands a task to another agent of the project, in a child conversation of its
 * own, on pi-durable's subagents (its examples 22 and 23). pi-durable gives the mechanism: a tool call
 * creates a conversation it owns, submits to it and waits; a background task owns one that outlives
 * the turn. What the runtime adds is pikit's: the child runs as another `AgentDefinition` (its model,
 * prompt, tools, extensions and skills, applied as every conversation's are), and a background task's
 * answer reaches the parent through `dispatch`, so it is logged in `answers` and its channel delivers
 * the parent's answer to the person.
 *
 * A tool reaches it through its context, `AGENT_DELEGATION` (the runtime's `scope` puts it there):
 *
 *   const delegation = context.value(AGENT_DELEGATION);
 *   const outcome = await delegation.run(api, { agent: "researcher", key, task, sender }, context);
 *
 * - **`run`** (foreground): the child is owned by the tool call's task, so aborting the call (the
 *   parent's run stopped) aborts the child, and the call ends once the child's work is done. A rerun of
 *   the call after a crash finds the child it created (pi-durable's ownership) and the input it
 *   submitted (its request id, `delegate:<tool task id>`), and waits again: the tool is replay-safe.
 * - **`start`** (background): an anchor task (background, of the parent conversation) owns the child,
 *   which outlives the parent's turns, and a reporter task (background too) submits the task, waits for
 *   its answer and admits a message to the parent (`delegate-result:<reporter id>`). Both are durable:
 *   a restart resumes them. What one call started is recorded in the parent's `pikit.delegations`
 *   document in the same commit, so a rerun of the call starts nothing twice.
 *
 * Everything happens in the parent's storage: on a server as in a Durable Object (Cloudflare, celld),
 * with no call between actors.
 */

import type { Context as ChordContext, JsonValue } from "@earendil-works/chord";
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTask,
  type EntryId,
  type SettledSubmissionRecord,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { type AppContext, type ContextKey, createContextKey } from "@pikit/core";
import { type AgentDefinition, type AgentRequest, type ConversationRef, isAgentUnavailable, type Sender } from "@pikit/contracts";
import { ConversationDoc } from "./agent.ts";
import { INPUT_KIND } from "./submissions.ts";

/** A task for another agent. */
export interface DelegatedTask {
  /** The agent that does it: an `agent.definition` (or a live agent) of the App. */
  agent: string;
  /**
   * The child conversation's key (`ConversationRef.key`), made by the tool, which owns that namespace
   * (`delegate:…`); its tools see it through `CONVERSATION`.
   */
  key: string;
  /** The child conversation's channel (`ConversationRef.channel`), the tool's own (`delegate`). */
  channel: string;
  /** The task: the child's one message. */
  task: string;
  /** Who asks: the child's input's sender (`RUN_REQUESTS`), the delegating agent. */
  sender?: Sender;
}

/** How a task ended. */
export type DelegatedOutcome = { kind: "completed"; text: string } | { kind: "failed"; message: string } | { kind: "aborted" };

export interface AgentDelegation {
  /** Runs `task` in a child conversation this tool call owns, and resolves with how it ended. */
  run(api: ToolExecutionApi, task: DelegatedTask, context: ChordContext): Promise<DelegatedOutcome>;
  /**
   * Starts `task` in a child conversation that outlives this run, and resolves once it is recorded; when
   * it ends, its answer is admitted to this conversation as a message of its own.
   */
  start(api: ToolExecutionApi, task: DelegatedTask, context: ChordContext): Promise<void>;
}

/** Where a tool's context carries the runtime's delegation. */
export const AGENT_DELEGATION: ContextKey<AgentDelegation> = createContextKey<AgentDelegation>("pikit.agent.delegation");

/** The prefix of the request id of a background task's result in its parent conversation. */
export const RESULT_REQUEST_PREFIX = "delegate-result:";

/** The extension the runtime installs with the delegation tasks, so a restart finds their definitions. */
export const DELEGATION_EXTENSION = "pikit.delegation";

/** Per tool task of the parent, what its background start created: a rerun finds it. */
const DelegationsDoc = defineDoc<{ [toolTaskId: string]: { child: number } }>({
  kind: "pikit.delegations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

type JsonSender = { channel: string; id: string };
type ReporterInput = {
  child: number;
  parent: { key: string; agent: string; conversationId: string };
  agent: string;
  task: string;
  requestId: string;
  sender?: JsonSender;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; outcome: DelegatedOutcome };

export interface DelegationOptions {
  /** The definition of an agent by name, or `undefined`. */
  agent(name: string): AgentDefinition | undefined;
  /** In `tx`, make the new conversation `id` run as `agent`, recorded as `ref` (the runtime's `AgentConfigs.apply`). */
  apply(tx: Tx, id: ConversationId, ref: ConversationRef, agent: AgentDefinition): Promise<void>;
  /** The runtime's `dispatch`: how a result reaches the parent, logged and announced. */
  dispatch(request: AgentRequest, ctx: AppContext): Promise<unknown>;
  /** The runtime's context, for the reporter's dispatch. */
  events: AppContext;
}

/** The answer's text of an answered input: its assistant entry's text parts. */
async function answerOf(tx: Tx, answer: EntryId): Promise<string> {
  const message = (await tx.entry(answer))?.model?.find((each) => each.role === "assistant");
  if (message?.role !== "assistant") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** How a settled input ended, as `DelegatedOutcome`. */
async function outcomeOf(tx: Tx, settled: SettledSubmissionRecord): Promise<DelegatedOutcome> {
  if (settled.status === "done" && settled.type === "input" && settled.answer !== undefined) return { kind: "completed", text: await answerOf(tx, settled.answer) };
  if (settled.reason === "aborted") return { kind: "aborted" };
  // A failed run's detail is its error, as pi-durable recorded it.
  const detail = settled.detail;
  const message = typeof detail === "string" ? detail : detail !== undefined && detail !== null ? JSON.stringify(detail) : undefined;
  return { kind: "failed", message: message ?? settled.reason ?? "it did not answer" };
}

/** What the parent's agent reads when a task it did not wait for ends. */
export function resultPrompt(agent: string, outcome: DelegatedOutcome): string {
  if (outcome.kind === "completed") {
    return `[The agent "${agent}" finished the task you delegated to it. Its answer follows: carry on with it, and tell the person what they need from it.]\n\n${outcome.text === "" ? "(nothing)" : outcome.text}`;
  }
  if (outcome.kind === "failed") return `[The agent "${agent}" could not do the task you delegated to it: ${outcome.message}. Tell the person, or do it another way.]`;
  return `[The task you delegated to the agent "${agent}" was stopped before it answered.]`;
}

const inputOf = (task: string, requestId: string, sender: JsonSender | undefined) =>
  ({ type: "input", content: task, requestId, ...(sender !== undefined && { entry: { kind: INPUT_KIND, data: { sender } } }) }) as const;

const plainSender = (sender: Sender | undefined): JsonSender | undefined => (sender === undefined ? undefined : { channel: sender.channel, id: sender.id });

/**
 * The delegation of a runtime, and the extension of its tasks (`DELEGATION_EXTENSION`), which the
 * runtime installs in its registry before it opens pi-durable.
 */
export function createDelegation(options: DelegationOptions) {
  /** Owns a background task's child conversation, so it outlives the turns that started it. */
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "pikit.delegation-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
    abort: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** Submits a background task, waits for its answer, and admits it to the parent conversation. */
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "pikit.delegation-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { child, task, requestId, sender } = reporter.input;
        const handle = await runtime.conversation(child as ConversationId, context);
        if (handle === undefined) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", outcome: { kind: "failed", message: "its conversation is gone" } } }), context);
          return;
        }
        // Its request id makes a rerun after a crash find the same submission.
        const settled = await (await handle.submit(inputOf(task, requestId, sender), context)).wait(context);
        await runtime.commit(async (tx) => ({ status: "running", checkpoint: { phase: "report", outcome: await outcomeOf(tx, settled) } }), context);
      },
      report: async (reporter, runtime, context) => {
        if (reporter.state.checkpoint.phase !== "report") return;
        const { parent, agent } = reporter.input;
        const ctx = options.events.derive(() => context);
        try {
          // Through the runtime: logged in `answers` and announced, so the parent's channel delivers its answer.
          await options.dispatch(
            { requestId: `${RESULT_REQUEST_PREFIX}${reporter.id}`, conversation: parent, prompt: resultPrompt(agent, reporter.state.checkpoint.outcome), sender: { channel: "delegate", id: agent } },
            ctx,
          );
        } catch (error) {
          if (!isAgentUnavailable(error)) throw error;
          ctx.logger.warn("a delegated task ended, but its parent's agent is no agent now; its result is not reported", { parent: parent.key, agent });
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_reporter, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** The definition of `name`, or a refusal the tool reports. */
  const definitionOf = (name: string): AgentDefinition => {
    const agent = options.agent(name);
    if (agent === undefined) throw new Error(`there is no agent "${name}" in this project`);
    return agent;
  };

  const delegation: AgentDelegation = {
    async run(api, task, context) {
      const agent = definitionOf(task.agent);
      const child = await api.commit(async (tx) => {
        // A rerun of this call finds the child it created.
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await options.apply(tx, created.id, { key: task.key, agent: task.agent, conversationId: String(created.id), channel: task.channel }, agent);
        return created.id;
      }, context);
      // A UI watching the parent finds the child under the call.
      await api.details({ conversationId: child } as JsonValue, context);
      const handle = await api.conversation(child, context);
      if (handle === undefined) return { kind: "failed", message: "its conversation is gone" };
      const settled = await (await handle.submit(inputOf(task.task, `delegate:${api.taskId}`, plainSender(task.sender)), context)).wait(context);
      return api.commit((tx) => outcomeOf(tx, settled), context);
    },

    async start(api, task, context) {
      const agent = definitionOf(task.agent);
      const parent = await api.commit(async (tx) => {
        const started = await tx.doc(DelegationsDoc, api.conversationId);
        if (Object.hasOwn(started, String(api.taskId))) return undefined;
        // The parent's key and agent, as the runtime recorded them.
        const recorded = await tx.doc(ConversationDoc, api.conversationId);
        // Both tasks belong to the parent conversation and are background: its stops and idle waits pass them by.
        const background = { ownership: { kind: "conversation" }, background: true } as const;
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await options.apply(tx, child.id, { key: task.key, agent: task.agent, conversationId: String(child.id), channel: task.channel }, agent);
        const sender = plainSender(task.sender);
        const input: ReporterInput = {
          child: child.id as number,
          parent: { key: recorded.key, agent: recorded.agent, conversationId: String(api.conversationId) },
          agent: task.agent,
          task: task.task,
          requestId: `delegate:${api.taskId}`,
          ...(sender !== undefined && { sender }),
        };
        await tx.createTask(Reporter, input, background);
        started[String(api.taskId)] = { child: child.id as number };
        return child.id;
      }, context);
      if (parent !== undefined) await api.details({ conversationId: parent } as JsonValue, context);
    },
  };

  return { delegation, extension: defineExtension({ name: DELEGATION_EXTENSION, tasks: [Anchor, Reporter] }) };
}
