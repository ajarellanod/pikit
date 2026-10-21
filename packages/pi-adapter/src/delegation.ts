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
 *   document in the same commit, under the call's task id, which is the task's id (`start` returns it):
 *   a rerun of the call starts nothing twice and returns the same id.
 * - **`list`, `steer`, `cancel`** control the background tasks of the calling conversation, and only
 *   those: they read its own `pikit.delegations`, so another conversation's id is `not_found`. A task's
 *   result is recorded there (bounded) in the commit that fixes what the reporter reports, so `list`
 *   survives restarts. A steer is recorded before it is sent, and refused once the result is fixed; the
 *   reporter waits for every recorded steer before it fixes it, so a steer that could not join the
 *   child's run (it came after its last tool round, and started a run of its own) is reported, never
 *   lost: the report is the last run's answer. A cancel marks the task and aborts the child; a marked
 *   task is reported stopped whatever the child answered, once; each submit to the child checks the
 *   mark after it, so no run started by a submit escapes a cancel.
 * - **`progress`** reads where one of those tasks is: its status and the child's last steps (assistant
 *   text, tool calls and how they ended), bounded, from the child's entries (`tx.scanEntries` in a
 *   commit that writes nothing), read in the parent's storage. Scoped as `list` (its `pikit.delegations`
 *   first), so another conversation's id is `not_found`. It shows the parent only what the child's own
 *   transcript holds, which the parent's storage already holds: a tool call's arguments as the child
 *   wrote them (a secret the child typed there too), clipped.
 *
 * - **The child's origin** (`ConversationRef.origin`) is written in its record when it is created, from
 *   the parent's: the parent's own origin when the parent is delegated too, else the parent. Its tools,
 *   hooks and sections see it in `CONVERSATION`, so they act for the person behind the tree (whose
 *   memory, where an approval or a scheduled prompt belongs: `originOf`). Nothing else sets it.
 * - **The child's parts** reach the person: a completed task's outcome carries the parts of the child's
 *   run that answered it (its messages' and tools' parts, as a run's result has them: a `question` its
 *   `ask_user` or `request_approval` asked), so `run`'s caller can give them with its tool result
 *   (`withParts`), and a background task's report brings them to the parent's run that takes it
 *   (`AgentRequest.parts`), whose answer the parent's channel delivers. The report's request id makes a
 *   rerun of the report a duplicate: they reach the parent's answers once.
 *
 * Everything happens in the parent's storage: on a server as in a Durable Object (Cloudflare, celld),
 * with no call between actors.
 */

import type { Context as ChordContext, JsonValue } from "@earendil-works/chord";
import {
  type ConversationId,
  type Cursor,
  defineDoc,
  defineExtension,
  defineTask,
  type EntryId,
  type ConversationHandle,
  type InputSubmissionDraft,
  type SettledSubmissionRecord,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { type AppContext, type ContextKey, createContextKey } from "@pikit/core";
import { type AgentDefinition, type AgentRequest, type ConversationOrigin, type ConversationRef, isAgentUnavailable, type MessagePart, type Sender } from "@pikit/contracts";
import { ConversationDoc, copyOrigin } from "./agent.ts";
import { isSettledInput, runParts, type SettledInput } from "./result.ts";
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

/**
 * How a task ended. A completed one's `parts` are those of the child's run that answered it (its
 * `AgentResult.parts`: what it asked the person, a question), in order; absent: none.
 */
export type DelegatedOutcome = { kind: "completed"; text: string; parts?: MessagePart[] } | { kind: "failed"; message: string } | { kind: "aborted" };

/** Where a background task is. */
export type DelegationStatus = "running" | "completed" | "failed" | "aborted";

/** A task this conversation started in the background (`start`). */
export interface BackgroundDelegation {
  /** What `start` returned. */
  id: string;
  /** The agent doing it. */
  agent: string;
  status: DelegationStatus;
  /** Once it ended: its answer (`completed`) or why it failed (`failed`), at most `RESULT_LIMIT` characters. */
  result?: string;
}

/**
 * One step of a task's child conversation, as `progress` reads it: what its model wrote (`text`, at most
 * `STEP_TEXT_LIMIT` characters), or a tool it called, with its arguments as JSON (at most
 * `STEP_ARGUMENTS_LIMIT` characters) and how the call is: `running` (no result written yet), `ok` or `error`.
 */
export type DelegationStep = { kind: "text"; text: string } | { kind: "tool"; name: string; arguments: string; status: "running" | "ok" | "error" };

/** Where a background task is (`progress`): as `list` has it, and the child's last steps. */
export interface DelegationProgress extends BackgroundDelegation {
  /** The child's last steps, at most `PROGRESS_STEPS`, oldest first; none before its model first answered. */
  steps: DelegationStep[];
  /** When the child last wrote to its conversation (its newest message's time, ms since the epoch); absent before it did. */
  updatedAt?: number;
}

export interface AgentDelegation {
  /** Runs `task` in a child conversation this tool call owns, and resolves with how it ended. */
  run(api: ToolExecutionApi, task: DelegatedTask, context: ChordContext): Promise<DelegatedOutcome>;
  /**
   * Starts `task` in a child conversation that outlives this run, and resolves with its id once it is
   * recorded (the call's task id: a rerun of the call gets the same); when it ends, its answer is
   * admitted to this conversation as a message of its own.
   */
  start(api: ToolExecutionApi, task: DelegatedTask, context: ChordContext): Promise<string>;
  /** The tasks this conversation started, oldest first; never another conversation's. Foreground (`run`) ones are the call's, not listed. */
  list(api: ToolExecutionApi, context: ChordContext): Promise<BackgroundDelegation[]>;
  /**
   * Where this conversation's task `id` is: its status (as `list`) and its child's last steps, running or
   * ended. Only reads. `not_found`: this conversation started no task `id`.
   */
  progress(api: ToolExecutionApi, id: string, context: ChordContext): Promise<DelegationProgress | "not_found">;
  /**
   * Sends `message` to this conversation's task `id` while it runs, from the sender it started with: it
   * joins the child's run, or runs right after it, and the task's one report is the answer to it.
   * `running`: sent (a rerun of the call sends nothing twice). Another status: it had ended, nothing is
   * sent. `not_found`: this conversation started no task `id`.
   */
  steer(api: ToolExecutionApi, id: string, message: string, context: ChordContext): Promise<DelegationStatus | "not_found">;
  /**
   * Stops this conversation's task `id`: it is reported to this conversation as stopped, once.
   * `aborted`: stopped (again: nothing more happens). Another status: it had ended, nothing is done.
   * `not_found`: this conversation started no task `id`.
   */
  cancel(api: ToolExecutionApi, id: string, context: ChordContext): Promise<DelegationStatus | "not_found">;
}

/** Where a tool's context carries the runtime's delegation. */
export const AGENT_DELEGATION: ContextKey<AgentDelegation> = createContextKey<AgentDelegation>("pikit.agent.delegation");

/** The prefix of the request id of a background task's result in its parent conversation. */
export const RESULT_REQUEST_PREFIX = "delegate-result:";

/** The extension the runtime installs with the delegation tasks, so a restart finds their definitions. */
export const DELEGATION_EXTENSION = "pikit.delegation";

/** How many characters of a task's answer (or failure) the parent's record keeps, for `list`. */
export const RESULT_LIMIT = 2000;

/** How many of the child's last steps `progress` gives. */
export const PROGRESS_STEPS = 5;
/** How many characters of a text step `progress` keeps. */
export const STEP_TEXT_LIMIT = 300;
/** How many characters of a tool call's arguments (as JSON) `progress` keeps. */
export const STEP_ARGUMENTS_LIMIT = 120;
/** How many of the child's newest entries `progress` reads at most, looking for its steps. */
const PROGRESS_SCAN = 200;

type JsonSender = { channel: string; id: string };
/** A steer, recorded before it is sent: the reporter sends it too if a crash came between. */
type Steer = { requestId: string; message: string };
/** What a background start created, and what became of it. */
type Delegation = {
  child: number;
  agent: string;
  sender?: JsonSender;
  steers?: Steer[];
  /** A cancel was asked: it is reported stopped. */
  cancelled?: true;
  /** How it ended, bounded, fixed in the reporter's commit. */
  result?: RecordedOutcome;
};

/** What `pikit.delegations` keeps of an outcome (`boundedOutcome`): no parts, which the report carries. */
type RecordedOutcome = { kind: "completed"; text: string } | { kind: "failed"; message: string } | { kind: "aborted" };

/** Per tool task of the parent, what its background start created: a rerun finds it. */
const DelegationsDoc = defineDoc<{ [toolTaskId: string]: Delegation }>({
  kind: "pikit.delegations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

type ReporterInput = {
  /** The task's id: its key in `pikit.delegations`; its input's request id is `delegate:<id>`. */
  id: string;
  child: number;
  parent: { key: string; agent: string; conversationId: string };
  agent: string;
  task: string;
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

/**
 * How a settled input of `child` ended, as `DelegatedOutcome`; a completed one with the parts of the run
 * that answered it: `run`, that run's inputs the delegation submitted (default: the input alone).
 */
async function outcomeOf(tx: Tx, child: ConversationId, settled: SettledSubmissionRecord, run?: readonly SettledInput[]): Promise<DelegatedOutcome> {
  if (settled.status === "done" && settled.type === "input" && settled.answer !== undefined) {
    const inputs = run ?? (isSettledInput(settled) ? [settled] : []);
    const parts = await runParts((query, limit, cursor) => tx.scanEntries({ conversationId: child, ...query }, limit, cursor), inputs);
    return { kind: "completed", text: await answerOf(tx, settled.answer), ...(parts.length > 0 && { parts }) };
  }
  if (settled.reason === "aborted") return { kind: "aborted" };
  // A failed run's detail is its error, as pi-durable recorded it.
  const detail = settled.detail;
  const message = typeof detail === "string" ? detail : detail !== undefined && detail !== null ? JSON.stringify(detail) : undefined;
  return { kind: "failed", message: message ?? settled.reason ?? "it did not answer" };
}

/**
 * What an agent reads of the parts a task's answer brings (`DelegatedOutcome.parts`): the person sees
 * them with its own answer, so it must not repeat them; their fallbacks say what they are. Empty for none.
 */
export function partsNote(parts: readonly MessagePart[] | undefined): string {
  if (parts === undefined || parts.length === 0) return "";
  const fallbacks = parts.map((part) => (part as { fallback: string }).fallback.trim()).filter((text) => text !== "");
  return `\n\n[The person is shown what follows with your answer, as it is: do not repeat it.]${fallbacks.length === 0 ? "" : `\n\n${fallbacks.join("\n\n")}`}`;
}

/** What the parent's agent reads when a task it did not wait for ends. */
export function resultPrompt(agent: string, outcome: DelegatedOutcome): string {
  if (outcome.kind === "completed") {
    return `[The agent "${agent}" finished the task you delegated to it. Its answer follows: carry on with it, and tell the person what they need from it.]\n\n${outcome.text === "" ? "(nothing)" : outcome.text}${partsNote(outcome.parts)}`;
  }
  if (outcome.kind === "failed") return `[The agent "${agent}" could not do the task you delegated to it: ${outcome.message}. Tell the person, or do it another way.]`;
  return `[The task you delegated to the agent "${agent}" was stopped before it answered.]`;
}

const inputOf = (task: string, requestId: string, sender: JsonSender | undefined): InputSubmissionDraft =>
  ({ type: "input", content: task, requestId, ...(sender !== undefined && { entry: { kind: INPUT_KIND, data: { sender } } }) }) as const;

const steerOf = (steer: Steer, sender: JsonSender | undefined): InputSubmissionDraft => ({ ...inputOf(steer.message, steer.requestId, sender), whenBusy: "steer" });

const clipTo = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)} [...]` : text);
const clip = (text: string) => clipTo(text, RESULT_LIMIT);

/** What `list` keeps of an outcome: its text or failure, bounded; never its parts (the report carries them). */
const boundedOutcome = (outcome: DelegatedOutcome): RecordedOutcome =>
  outcome.kind === "completed" ? { kind: "completed", text: clip(outcome.text) } : outcome.kind === "failed" ? { kind: "failed", message: clip(outcome.message) } : outcome;

/**
 * In `tx`: the last `PROGRESS_STEPS` steps of `child`, oldest first, and when it last wrote. Reads its
 * newest entries back (at most `PROGRESS_SCAN`): a tool call's result comes after it, so it is read first.
 */
async function stepsOf(tx: Tx, child: ConversationId): Promise<{ steps: DelegationStep[]; updatedAt?: number }> {
  const newestFirst: DelegationStep[] = [];
  const results = new Map<string, boolean>();
  let updatedAt: number | undefined;
  let read = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: child, order: "descending" }, Math.min(50, PROGRESS_SCAN - read), cursor);
    for (const entry of page.items) {
      for (const message of [...(entry.model ?? [])].reverse()) {
        if (message.role === "system") continue;
        updatedAt ??= message.role === "assistant" ? message.timestamp + (message.durationMs ?? 0) : message.timestamp;
        if (message.role === "toolResult") results.set(message.toolCallId, message.isError);
        if (message.role !== "assistant") continue;
        const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
        const calls = message.content.flatMap((part): DelegationStep[] => {
          if (part.type !== "toolCall") return [];
          const ended = results.get(part.id);
          return [{ kind: "tool", name: part.name, arguments: clipTo(JSON.stringify(part.arguments), STEP_ARGUMENTS_LIMIT), status: ended === undefined ? "running" : ended ? "error" : "ok" }];
        });
        newestFirst.push(...calls.reverse(), ...(text === "" ? [] : [{ kind: "text" as const, text: clipTo(text, STEP_TEXT_LIMIT) }]));
      }
      if (newestFirst.length >= PROGRESS_STEPS) break;
    }
    read += page.items.length;
    cursor = page.next;
  } while (cursor !== undefined && newestFirst.length < PROGRESS_STEPS && read < PROGRESS_SCAN);
  return { steps: newestFirst.slice(0, PROGRESS_STEPS).reverse(), ...(updatedAt !== undefined && { updatedAt }) };
}

/**
 * In `tx`: the origin of a conversation `parent` delegates from, as its record has it: its own origin
 * when it is delegated too, else itself.
 */
async function originFrom(tx: Tx, parent: ConversationId): Promise<ConversationOrigin> {
  const recorded = await tx.doc(ConversationDoc, parent);
  if (recorded.origin !== undefined) return copyOrigin(recorded.origin);
  return { key: recorded.key, agent: recorded.agent, conversationId: String(parent), ...(recorded.channel !== undefined && { channel: recorded.channel }) };
}

/** In `tx`: a new conversation for a task, owned by `owner`, recorded with `origin`, and run as `agent` (`options.apply`). */
async function createChild(
  tx: Tx,
  options: Pick<DelegationOptions, "apply">,
  owner: TaskId,
  origin: ConversationOrigin,
  task: DelegatedTask,
  agent: AgentDefinition,
): Promise<ConversationId> {
  const created = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
  // Before `apply`, which gives the ref as recorded: the origin is the delegation's to write, never a ref's.
  (await tx.doc(ConversationDoc, created.id)).origin = origin;
  await options.apply(tx, created.id, { key: task.key, agent: task.agent, conversationId: String(created.id), channel: task.channel }, agent);
  return created.id;
}

const statusOf = (record: Delegation): DelegationStatus => record.result?.kind ?? (record.cancelled === true ? "aborted" : "running");

/**
 * Submits `draft` to a background task's child, then aborts the child if the task was cancelled: a
 * cancel either aborted the run this submit started, or committed before this read.
 */
async function submitTo(reader: Pick<ToolExecutionApi, "snapshot">, parent: ConversationId, id: string, child: ConversationHandle, draft: InputSubmissionDraft, context: ChordContext) {
  const submission = await child.submit(draft, context);
  if ((await reader.snapshot(DelegationsDoc, parent, context))?.[id]?.cancelled === true) await child.abort(context);
  return submission;
}

/** The background tasks of `records` (`pikit.delegations`' entries), as `list` gives them. */
const backgroundOf = (records: [string, Readonly<Delegation>][]): BackgroundDelegation[] =>
  records.map(([id, record]) => {
    const result = record.result?.kind === "completed" ? record.result.text : record.result?.kind === "failed" ? record.result.message : undefined;
    return { id, agent: record.agent, status: statusOf(record), ...(result !== undefined && { result }) };
  });

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
        const { id, task, sender } = reporter.input;
        const child = reporter.input.child as ConversationId;
        const parent = runtime.conversationId;
        const handle = await runtime.conversation(child, context);
        // `start` submitted it; its request id makes this find the same submission.
        if (handle !== undefined) await (await submitTo(runtime, parent, id, handle, inputOf(task, `delegate:${id}`, sender), context)).wait(context);
        for (;;) {
          // The outcome is fixed only once every steer recorded is answered: the last one's run is the report.
          let pending = undefined as Steer | undefined;
          await runtime.commit(async (tx) => {
            const record = (await tx.doc(DelegationsDoc, parent))[id];
            let outcome: DelegatedOutcome;
            if (record?.cancelled === true) outcome = { kind: "aborted" };
            else if (handle === undefined) outcome = { kind: "failed", message: "its conversation is gone" };
            else {
              let last = `delegate:${id}`;
              for (const steer of record?.steers ?? []) {
                const submitted = await tx.submissionByRequest(child, steer.requestId);
                if (submitted?.status !== "done" && submitted?.status !== "unanswered") {
                  pending = { requestId: steer.requestId, message: steer.message };
                  return undefined;
                }
                last = steer.requestId;
              }
              const final = (await tx.submissionByRequest(child, last)) as SettledSubmissionRecord;
              // The run that answered it took the task's inputs that share its answer (a steer that joined it).
              const run: SettledInput[] = [];
              for (const requestId of [`delegate:${id}`, ...(record?.steers ?? []).map((steer) => steer.requestId)]) {
                const submitted = await tx.submissionByRequest(child, requestId);
                if (submitted !== undefined && isSettledInput(submitted) && submitted.status === "done" && final.status === "done" && submitted.answer === final.answer) run.push(submitted);
              }
              outcome = await outcomeOf(tx, child, final, run.length === 0 ? undefined : run.sort((a, b) => a.id - b.id));
            }
            if (record !== undefined) record.result = boundedOutcome(outcome);
            return { status: "running", checkpoint: { phase: "report", outcome } };
          }, context);
          if (pending === undefined || handle === undefined) return;
          await (await submitTo(runtime, parent, id, handle, steerOf(pending, sender), context)).wait(context);
        }
      },
      report: async (reporter, runtime, context) => {
        if (reporter.state.checkpoint.phase !== "report") return;
        const { parent, agent } = reporter.input;
        const { outcome } = reporter.state.checkpoint;
        const ctx = options.events.derive(() => context);
        try {
          // Through the runtime: logged in `answers` and announced, so the parent's channel delivers its answer,
          // with the child's parts (a question it asked). Its request id makes a rerun a duplicate.
          await options.dispatch(
            {
              requestId: `${RESULT_REQUEST_PREFIX}${reporter.id}`,
              conversation: parent,
              prompt: resultPrompt(agent, outcome),
              sender: { channel: "delegate", id: agent },
              ...(outcome.kind === "completed" && outcome.parts !== undefined && outcome.parts.length > 0 && { parts: outcome.parts }),
            },
            ctx,
          );
        } catch (error) {
          if (!isAgentUnavailable(error)) throw error;
          ctx.logger.warn("a delegated task ended, but its parent's agent is no agent now; its result is not reported", { parent: parent.key, agent });
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    // Stopped with its parent's background work: it reports nothing, and `list` says so.
    abort: (reporter, runtime, context) =>
      runtime.commit(async (tx) => {
        const record = (await tx.doc(DelegationsDoc, runtime.conversationId))[reporter.input.id];
        if (record !== undefined && record.result === undefined) record.result = { kind: "aborted" };
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
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
        return createChild(tx, options, api.taskId, await originFrom(tx, api.conversationId), task, agent);
      }, context);
      // A UI watching the parent finds the child under the call.
      await api.details({ conversationId: child } as JsonValue, context);
      const handle = await api.conversation(child, context);
      if (handle === undefined) return { kind: "failed", message: "its conversation is gone" };
      const settled = await (await handle.submit(inputOf(task.task, `delegate:${api.taskId}`, plainSender(task.sender)), context)).wait(context);
      return api.commit((tx) => outcomeOf(tx, child, settled), context);
    },

    async start(api, task, context) {
      const agent = definitionOf(task.agent);
      const id = String(api.taskId);
      const sender = plainSender(task.sender);
      const child = await api.commit(async (tx) => {
        const started = await tx.doc(DelegationsDoc, api.conversationId);
        const existing = started[id];
        if (existing !== undefined) return existing.child as ConversationId;
        // The parent's key and agent, as the runtime recorded them.
        const recorded = await tx.doc(ConversationDoc, api.conversationId);
        // Both tasks belong to the parent conversation and are background: its stops and idle waits pass them by.
        const background = { ownership: { kind: "conversation" }, background: true } as const;
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await createChild(tx, options, anchor, await originFrom(tx, api.conversationId), task, agent);
        const input: ReporterInput = {
          id,
          child: child as number,
          parent: { key: recorded.key, agent: recorded.agent, conversationId: String(api.conversationId) },
          agent: task.agent,
          task: task.task,
          ...(sender !== undefined && { sender }),
        };
        await tx.createTask(Reporter, input, background);
        started[id] = { child: child as number, agent: task.agent, ...(sender !== undefined && { sender }) };
        return child;
      }, context);
      await api.details({ conversationId: child } as JsonValue, context);
      // Submitted before the id is returned, so no steer reaches the child before its task.
      const handle = await api.conversation(child, context);
      if (handle !== undefined) await submitTo(api, api.conversationId, id, handle, inputOf(task.task, `delegate:${id}`, sender), context);
      return id;
    },

    async list(api, context) {
      return backgroundOf(Object.entries((await api.snapshot(DelegationsDoc, api.conversationId, context)) ?? {}));
    },

    async progress(api, id, context) {
      // As `list`: this conversation's own record, so another's task is not found.
      const record = (await api.snapshot(DelegationsDoc, api.conversationId, context))?.[id];
      if (record === undefined) return "not_found";
      const [listed] = backgroundOf([[id, record]]);
      // A commit that only reads: it writes nothing.
      const read = await api.commit((tx) => stepsOf(tx, record.child as ConversationId), context);
      return { ...(listed as BackgroundDelegation), ...read };
    },

    async steer(api, id, message, context) {
      const requestId = `delegate-steer:${String(api.taskId)}`;
      const found = await api.commit(async (tx) => {
        const record = (await tx.doc(DelegationsDoc, api.conversationId))[id];
        if (record === undefined) return "not_found" as const;
        const sent = record.steers?.some((steer) => steer.requestId === requestId) === true;
        // Once its outcome is fixed nothing joins it: the reporter fixes it only after every steer recorded.
        if (!sent && statusOf(record) !== "running") return statusOf(record);
        // A new array: a draft copies what is assigned to it, so a push after `??=` would be lost.
        if (!sent) record.steers = [...(record.steers ?? []), { requestId, message }];
        return { child: record.child as ConversationId, sender: plainSender(record.sender) };
      }, context);
      if (typeof found === "string") return found;
      const handle = await api.conversation(found.child, context);
      if (handle === undefined) return "failed";
      await submitTo(api, api.conversationId, id, handle, steerOf({ requestId, message }, found.sender), context);
      return "running";
    },

    async cancel(api, id, context) {
      const found = await api.commit(async (tx) => {
        const record = (await tx.doc(DelegationsDoc, api.conversationId))[id];
        if (record === undefined) return "not_found" as const;
        if (record.result !== undefined) return record.result.kind;
        record.cancelled = true;
        return record.child as ConversationId;
      }, context);
      if (typeof found === "string") return found;
      // Aborted again by a second cancel (an idle child: nothing happens), so a rerun after a crash still stops it.
      await (await api.conversation(found, context))?.abort(context);
      return "aborted";
    },
  };

  return { delegation, extension: defineExtension({ name: DELEGATION_EXTENSION, tasks: [Anchor, Reporter] }) };
}
