/**
 * tool-delegate: the agent tool `delegate`, for the agents that name it (`tools: ["delegate"]`). It
 * hands a task to another agent of the project, the ones its config lists, and gets the answer: now
 * (`wait`, the default), or later, as a message in the conversation (`wait: false`).
 *
 * - **The task is a child conversation** of the agent the call names, on pi-durable's subagents, which
 *   the runtime gives tools through their context (`AGENT_DELEGATION`, `@pikit/pi-adapter/tools`):
 *   `run` (the child is owned by the call: stopping the parent's run stops it) or `start` (the child
 *   outlives the run; its answer is admitted to this conversation when it ends). It lives in this
 *   conversation's storage: the same on a server as in a Durable Object.
 * - **Which agents, and how deep**, is this tool's config: the agents it may hand work to, each with
 *   what it is for (the model reads it to pick one), and `maxDepth`, how many delegations deep a task
 *   may be (a delegated agent that names `delegate` delegates again, one level deeper). A delegated task
 *   always waits for its own delegations: only a conversation a person started gets answers later.
 * - **Who may delegate to an agent**: an agent of the config with `from` takes tasks only from those
 *   agents, and only when every agent of the call's chain is one of them: the calling conversation's
 *   agent and each above it, up to the conversation a person or a channel started. So `support` cannot
 *   reach `developer` through an `orchestrator` it may delegate to. The chain is never the model's: it
 *   is in the keys this tool makes, checked against the origin the runtime fixed; a chain it cannot
 *   trust reaches no such agent (fail closed). An agent without `from` takes tasks from any agent.
 * - **The child's key** is `delegate:<depth>:<chain>:<tool call's task id>`, `<chain>` the child's
 *   ancestors' agents, root first, joined by `.` (agent names are kebab-case): this tool owns that
 *   namespace, and reads a conversation's depth and chain from it (`depthOf`, `chainOf`). A chain it
 *   cannot trust is written empty, so no task under it reaches an agent with `from`. The child's
 *   sender is the delegating agent (`{ channel: "delegate", id }`), which its tools and hooks read
 *   (`RUN_REQUESTS`). Its origin (`ConversationRef.origin`: the conversation the person talks in) is
 *   the runtime's to set.
 * - **What the child asks the person reaches them**: a question its `askUser` or `request_approval`
 *   asked (its run's parts) goes with this call's result (`withParts`) when it waits, and with the
 *   task's report when it does not; either way with the answer of this conversation's run, which its
 *   channel delivers. The answer comes back here as a message: hand it on with a new delegation.
 * - **Replay is `safe`**: a call made again after a crash finds the child it created and the input it
 *   submitted (pi-durable's ownership and request ids), and only waits again.
 * - **The tasks it did not wait for** have an id (`wait: false` returns it), and three tools of their
 *   own, which an agent names apart (and `extension-house-rules` can allow per sender): `delegate_tasks`
 *   lists them or reads one, `delegate_steer` sends one a message while it runs, `delegate_cancel` stops
 *   one. Each sees only the tasks of its own conversation (`list`, `steer`, `cancel` of
 *   `AGENT_DELEGATION`). All `safe`: listing reads, a steer's request id is its call's (a rerun sends
 *   nothing twice), and a cancel done again changes nothing.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific, and the child is the parent's
 * own storage's.
 */

import { defineComponent } from "@pikit/core";
import { CONVERSATION, type ConversationRef, originOf } from "@pikit/contracts";
import { AGENT_DELEGATION, type AgentDelegation, type BackgroundDelegation, defineTool, partsNote, type ToolRegistration, withParts } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";

/** The name agents give it, and its key under `agent.tool`. */
export const DELEGATE_TOOL = "delegate";
/** The tools of the tasks it did not wait for: list or read one, steer one, stop one. */
export const TASKS_TOOL = "delegate_tasks";
export const STEER_TOOL = "delegate_steer";
export const CANCEL_TOOL = "delegate_cancel";
/** The prefix of a delegated task's conversation key, which this tool makes and reads. */
export const DELEGATE_KEY_PREFIX = "delegate:";
/** The channel of a delegated task's message, as its sender says it. */
export const DELEGATE_CHANNEL = "delegate";

/** The separator of a key's chain: agent names are kebab-case, so never hold it (nor a `:`). */
const CHAIN_SEPARATOR = ".";
/** An agent's name as `defineAgent` takes it; a key's chain holds only such names. */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** An agent's name: `start` checks it is an `agent.definition`. */
const AgentName = Type.String({ minLength: 1 });

const Config = Type.Object(
  {
    /**
     * The agents it may hand work to, each with what it is for: what the model reads to pick one. With
     * `from`, only those agents may delegate to it, and only when every agent above them in the
     * delegation is one of them too; without, any agent may.
     */
    agents: Type.Array(Type.Object({ name: AgentName, description: Type.String({ minLength: 1 }), from: Type.Optional(Type.Array(AgentName, { minItems: 1 })) }), { minItems: 1 }),
    /** How many delegations deep a task may be: 1, only the agents a person talks to delegate. */
    maxDepth: Type.Integer({ minimum: 1, maximum: 5, default: 2 }),
  },
  {
    examples: [
      { agents: [{ name: "researcher", description: "Finds and reads sources on the web, and answers with what they say." }] },
      { agents: [{ name: "developer", description: "Changes code in the repository and opens pull requests.", from: ["orchestrator"] }] },
    ],
  },
);

export type DelegateConfig = Static<typeof Config>;

/** How deep a conversation is in delegations: 0 for one a person (or a channel) started. */
export function depthOf(key: string): number {
  if (!key.startsWith(DELEGATE_KEY_PREFIX)) return 0;
  const depth = Number(key.slice(DELEGATE_KEY_PREFIX.length).split(":", 1)[0]);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * The agents above a conversation in its delegation, root first, as its key says: `[]` for one not
 * delegated (its key is not `delegate:`), `undefined` for a `delegate:` key that does not say them
 * (malformed, or a chain written empty because it could not be trusted). As many as its depth.
 */
export function chainOf(key: string): string[] | undefined {
  if (!key.startsWith(DELEGATE_KEY_PREFIX)) return [];
  const rest = key.slice(DELEGATE_KEY_PREFIX.length);
  const first = rest.indexOf(":");
  const second = first < 0 ? -1 : rest.indexOf(":", first + 1);
  // The task id after the chain: a key without one is not this tool's.
  if (second < 0 || second === rest.length - 1) return undefined;
  const chain = rest.slice(first + 1, second).split(CHAIN_SEPARATOR);
  return chain.every((agent) => AGENT_NAME.test(agent)) && chain.length === depthOf(key) ? chain : undefined;
}

/**
 * The agents a `delegate` call in `conversation` comes from, root first: those above it and its own,
 * or `undefined` when they cannot be trusted. Above it is its key's chain, which only this tool
 * writes, and whose first agent must be its origin's (the runtime fixes the origin, never a ref or the
 * model). A conversation not delegated is its own root, with no origin.
 */
export function callersOf(conversation: ConversationRef): string[] | undefined {
  if (!AGENT_NAME.test(conversation.agent)) return undefined;
  // Not this tool's key but delegated (an origin): who is above it is unknown.
  if (!conversation.key.startsWith(DELEGATE_KEY_PREFIX)) return conversation.origin === undefined ? [conversation.agent] : undefined;
  const chain = chainOf(conversation.key);
  if (chain === undefined || conversation.origin === undefined || chain[0] !== originOf(conversation).agent) return undefined;
  return [...chain, conversation.agent];
}

/** Why `callers` may not delegate to `agent`, or `undefined` when they may. */
function refusal(agent: DelegateConfig["agents"][number], callers: string[] | undefined): string | undefined {
  const from = agent.from;
  if (from === undefined || (callers !== undefined && callers.every((caller) => from.includes(caller)))) return undefined;
  const who =
    callers === undefined
      ? "this conversation's chain of delegations cannot be verified, so it"
      : `this conversation (${callers.at(-1)}${callers.length > 1 ? `, delegated from ${callers.slice(0, -1).join(" then ")}` : ""})`;
  return `the agent "${agent.name}" takes tasks only from ${from.join(", ")}; ${who} may not delegate to it: do it yourself, or delegate to another agent`;
}

/** The tool's description: what it does, and the agents it hands work to. */
export function delegateDescription(config: DelegateConfig): string {
  return [
    "Hands a task to another agent of this project and gets its answer. Each call is a new conversation of that agent, which starts with nothing but the task: write everything it needs in it.",
    "By default the call waits for the agent's answer. With wait: false it returns at once, with the task's id, and the answer arrives later in this conversation, as a message: use it for long tasks, and carry on meanwhile.",
    "The agents:",
    ...config.agents.map((agent) => `- ${agent.name}: ${agent.description}${agent.from === undefined ? "" : ` (only from: ${agent.from.join(", ")})`}`),
  ].join("\n");
}

/** The `delegate` tool for `config`. */
export function createDelegateTool(config: DelegateConfig): ToolRegistration {
  const names = config.agents.map((agent) => agent.name);
  const Parameters = Type.Object({
    agent: Type.Union(
      names.map((name) => Type.Literal(name)),
      { description: "The agent to hand the task to." },
    ),
    task: Type.String({ minLength: 1, description: "The task, with everything the agent needs to do it." }),
    wait: Type.Optional(Type.Boolean({ description: "Wait for the answer (default true), or get it later as a message (false)." })),
  });
  return defineTool({
    name: DELEGATE_TOOL,
    description: delegateDescription(config),
    parameters: Parameters,
    replay: "safe",
    async execute(args, api, context) {
      const parent = context.value(CONVERSATION);
      const delegation = context.value(AGENT_DELEGATION);
      if (parent === undefined || delegation === undefined) throw new Error("delegate runs only in a conversation's run");
      const target = config.agents.find((agent) => agent.name === args.agent);
      if (target === undefined) throw new Error(`there is no agent "${args.agent}" to delegate to; the agents are: ${names.join(", ")}`);
      const callers = callersOf(parent);
      const refused = refusal(target, callers);
      if (refused !== undefined) throw new Error(refused);
      const depth = depthOf(parent.key) + 1;
      if (depth > config.maxDepth) {
        throw new Error(`this task is already ${depth - 1} delegation${depth - 1 === 1 ? "" : "s"} deep, the most this project allows: do it yourself`);
      }
      // The child's chain is the callers; one that cannot be trusted is written empty, so it stays so below.
      const chain = callers === undefined ? "" : callers.join(CHAIN_SEPARATOR);
      const task = {
        agent: args.agent,
        key: `${DELEGATE_KEY_PREFIX}${depth}:${chain}:${String(api.taskId)}`,
        channel: DELEGATE_CHANNEL,
        task: args.task,
        sender: { channel: DELEGATE_CHANNEL, id: parent.agent },
      };
      // Only a conversation a person started gets answers later: a delegated task waits for its own.
      if (args.wait === false && depth === 1) {
        const id = await delegation.start(api, task, context);
        return { output: [{ type: "text", text: `The task "${id}" is with the agent "${args.agent}" now. Its answer will arrive in this conversation as a message when it ends; carry on meanwhile.` }] };
      }
      const outcome = await delegation.run(api, task, context);
      if (outcome.kind === "completed") {
        const answered = { output: [{ type: "text" as const, text: `The agent "${args.agent}" answered:\n\n${outcome.text === "" ? "(nothing)" : outcome.text}${partsNote(outcome.parts)}` }] };
        // What the child asked the person (a question) goes with this run's answer.
        return outcome.parts === undefined || outcome.parts.length === 0 ? answered : withParts(answered, outcome.parts);
      }
      if (outcome.kind === "failed") throw new Error(`the agent "${args.agent}" could not do the task: ${outcome.message}`);
      throw new Error(`the agent "${args.agent}" was stopped before it answered`);
    },
  }) as unknown as ToolRegistration;
}

/** The runtime's delegation, in a conversation's run. */
function delegationIn(context: { value: (key: typeof AGENT_DELEGATION) => AgentDelegation | undefined }): AgentDelegation {
  const delegation = context.value(AGENT_DELEGATION);
  if (delegation === undefined) throw new Error("this tool runs only in a conversation's run");
  return delegation;
}

const notFound = (id: string) => new Error(`there is no task "${id}" started from this conversation`);

const TaskId = Type.String({ minLength: 1, description: "The task's id, as delegate returned it." });

const line = (task: BackgroundDelegation) => `- ${task.id}: the agent "${task.agent}", ${task.status}${task.result === undefined ? "" : `:\n${task.result}`}`;

/** `delegate_tasks`: this conversation's tasks, or one. */
export function createTasksTool(): ToolRegistration {
  return defineTool({
    name: TASKS_TOOL,
    description:
      "Lists the tasks this conversation handed to other agents without waiting (delegate with wait: false): each one's id, agent and status (running, completed, failed or aborted), and how it ended. With an id, only that task.",
    parameters: Type.Object({ id: Type.Optional(TaskId) }),
    replay: "safe",
    async execute(args, api, context) {
      const tasks = await delegationIn(context).list(api, context);
      const shown = args.id === undefined ? tasks : tasks.filter((task) => task.id === args.id);
      if (args.id !== undefined && shown.length === 0) throw notFound(args.id);
      return { output: [{ type: "text", text: shown.length === 0 ? "No task was handed over from this conversation without waiting." : shown.map(line).join("\n") }] };
    },
  }) as unknown as ToolRegistration;
}

/** `delegate_steer`: a message to a running task. */
export function createSteerTool(): ToolRegistration {
  return defineTool({
    name: STEER_TOOL,
    description:
      "Sends a message to a task this conversation handed to another agent without waiting, while it runs: to correct or add to it. The agent reads it as soon as it can; the task's answer arrives in this conversation as before.",
    parameters: Type.Object({ id: TaskId, message: Type.String({ minLength: 1, description: "What to tell the agent." }) }),
    replay: "safe",
    async execute(args, api, context) {
      const status = await delegationIn(context).steer(api, args.id, args.message, context);
      if (status === "not_found") throw notFound(args.id);
      if (status !== "running") throw new Error(`the task "${args.id}" has already ended (${status}): nothing was sent`);
      return { output: [{ type: "text", text: `The message is with the task "${args.id}". Its answer will arrive in this conversation when it ends.` }] };
    },
  }) as unknown as ToolRegistration;
}

/** `delegate_cancel`: stops a running task. */
export function createCancelTool(): ToolRegistration {
  return defineTool({
    name: CANCEL_TOOL,
    description: "Stops a task this conversation handed to another agent without waiting. This conversation then gets one message saying it was stopped.",
    parameters: Type.Object({ id: TaskId }),
    replay: "safe",
    async execute(args, api, context) {
      const status = await delegationIn(context).cancel(api, args.id, context);
      if (status === "not_found") throw notFound(args.id);
      const text = status === "aborted" ? `The task "${args.id}" is stopped.` : `The task "${args.id}" had already ended (${status}): nothing to stop.`;
      return { output: [{ type: "text", text }] };
    },
  }) as unknown as ToolRegistration;
}

export default defineComponent({
  name: "tool-delegate",
  config: Config,
  setup(pikit, config) {
    const agents = pikit.useKeyed("agent.definition");
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match. Its
    // `summary` is what an operator reads next to it in the dashboard (the model reads its description).
    pikit.provideKeyed("agent.tool", DELEGATE_TOOL, { ...createDelegateTool(config), summary: "Hands a task to another agent of the project, and gets its answer" });
    pikit.provideKeyed("agent.tool", TASKS_TOOL, { ...createTasksTool(), summary: "Lists the tasks handed to other agents without waiting, and how they ended" });
    pikit.provideKeyed("agent.tool", STEER_TOOL, { ...createSteerTool(), summary: "Sends a message to a task another agent is doing" });
    pikit.provideKeyed("agent.tool", CANCEL_TOOL, { ...createCancelTool(), summary: "Stops a task another agent is doing" });
    return {
      start() {
        // Every agent it names, in `agents` and in each `from`, is an agent.definition.
        const missing: string[] = [];
        const check = (names: string[], where: string) => {
          const absent = names.filter((name) => agents.get(name) === undefined);
          if (absent.length > 0) missing.push(`${absent.map((name) => `"${name}"`).join(", ")} in ${where}`);
        };
        check(config.agents.map((agent) => agent.name), "its agents");
        for (const agent of config.agents) check(agent.from ?? [], `the from of "${agent.name}"`);
        if (missing.length > 0) {
          throw new Error(`tool-delegate: ${missing.join("; ")} is no agent.definition (agents: ${agents.keys().join(", ") || "none"}): take it out of the config, or define it`);
        }
      },
    };
  },
});
